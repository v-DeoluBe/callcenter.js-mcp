import OpenAI from "openai";
import { EventTopic } from "./types.js";
import { getLogger } from "./logger.js";

export interface CallRouterConfig {
  openaiApiKey: string;
  topics: EventTopic[];
  confidenceThreshold?: number; // 0-1, defaults to 0.5
}

export interface RoutingDecision {
  topic: EventTopic | null;
  confidence: number;
  reasoning?: string;
}

/**
 * Routes an inbound caller's spoken question to the most relevant configured
 * "event"/topic, then produces an answer for that topic - either by calling
 * an external MCP-style HTTP endpoint or, if none is configured/reachable,
 * by grounding a completion in the topic's static knowledge text.
 */
export class CallRouter {
  private openai: OpenAI;
  private topics: EventTopic[];
  private confidenceThreshold: number;

  constructor(config: CallRouterConfig) {
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.topics = config.topics || [];
    this.confidenceThreshold = config.confidenceThreshold ?? 0.5;
  }

  hasTopics(): boolean {
    return this.topics.length > 0;
  }

  getTopic(id: string): EventTopic | undefined {
    return this.topics.find((topic) => topic.id === id);
  }

  /**
   * Classify a caller's utterance against the configured topic registry.
   * Returns the best matching topic (if any) along with a 0-1 confidence
   * score. Returns { topic: null } when nothing meets the confidence
   * threshold, so the caller can be given a graceful fallback response.
   */
  async classify(utterance: string): Promise<RoutingDecision> {
    if (!this.hasTopics()) {
      return { topic: null, confidence: 0, reasoning: "No topics configured" };
    }

    const topicSummaries = this.topics
      .map((topic) => {
        const keywordHint = topic.keywords?.length
          ? ` (keywords: ${topic.keywords.join(", ")})`
          : "";
        return `- id: "${topic.id}" | ${topic.name}: ${topic.description}${keywordHint}`;
      })
      .join("\n");

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a call routing assistant for an inbound phone line. " +
              "Given the caller's question and a registry of topics/events the system can answer questions about, " +
              "pick the single best matching topic id, or \"none\" if nothing is a reasonable match. " +
              "Respond only with the requested JSON.",
          },
          {
            role: "user",
            content: `Available topics:\n${topicSummaries}\n\nCaller said: "${utterance}"`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "routing_decision",
            strict: true,
            schema: {
              type: "object",
              properties: {
                topic_id: {
                  type: "string",
                  description: "The id of the best matching topic, or \"none\" if no topic is a good match",
                },
                confidence: {
                  type: "number",
                  description: "Confidence in this routing decision, from 0 (no match) to 1 (certain match)",
                },
                reasoning: {
                  type: "string",
                  description: "One short sentence explaining the routing decision",
                },
              },
              required: ["topic_id", "confidence", "reasoning"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("No response from routing model");
      }

      const parsed = JSON.parse(content) as {
        topic_id: string;
        confidence: number;
        reasoning: string;
      };

      const matchedTopic =
        parsed.topic_id && parsed.topic_id !== "none"
          ? this.getTopic(parsed.topic_id) || null
          : null;

      const decision: RoutingDecision = {
        topic: matchedTopic && parsed.confidence >= this.confidenceThreshold ? matchedTopic : null,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      };

      getLogger().ai.debug(
        `Call router decision: topic=${decision.topic?.id || "none"} confidence=${decision.confidence} (${decision.reasoning})`
      );

      return decision;
    } catch (error) {
      getLogger().ai.error(
        "Call router classification failed:",
        error instanceof Error ? error.message : String(error)
      );
      return { topic: null, confidence: 0, reasoning: "Classification error" };
    }
  }

  /**
   * Produce an answer to the caller's question for the given topic.
   * Prefers the topic's mcpEndpoint (a simple HTTP JSON contract:
   * POST { question } -> { answer }) and falls back to a knowledge-grounded
   * completion using the topic's static `knowledge` text.
   */
  async answer(topic: EventTopic, question: string): Promise<string> {
    if (topic.mcpEndpoint) {
      try {
        return await this.answerFromMcpEndpoint(topic.mcpEndpoint, question);
      } catch (error) {
        getLogger().ai.warn(
          `MCP endpoint for topic "${topic.id}" failed, falling back to static knowledge:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (topic.knowledge) {
      return this.answerFromKnowledge(topic, question);
    }

    return `I have information about ${topic.name}, but I couldn't find a specific answer to that question.`;
  }

  private async answerFromMcpEndpoint(endpoint: string, question: string): Promise<string> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`MCP endpoint returned status ${response.status}`);
    }

    const data = (await response.json()) as { answer?: string };
    if (!data.answer) {
      throw new Error("MCP endpoint response did not include an answer");
    }

    return data.answer;
  }

  private async answerFromKnowledge(topic: EventTopic, question: string): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `You are answering a phone caller's question about "${topic.name}". ` +
            "Use only the reference information below to answer. Be concise and conversational, " +
            "as this answer will be spoken aloud. If the reference information doesn't cover the " +
            "question, say you don't have that specific detail.\n\n" +
            `Reference information:\n${topic.knowledge}`,
        },
        { role: "user", content: question },
      ],
    });

    return (
      response.choices[0]?.message?.content?.trim() ||
      `I have information about ${topic.name}, but couldn't generate an answer right now.`
    );
  }
}
