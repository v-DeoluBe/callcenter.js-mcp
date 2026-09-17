import { EventTopic } from "./types.js";
export interface CallRouterConfig {
    openaiApiKey: string;
    topics: EventTopic[];
    confidenceThreshold?: number;
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
export declare class CallRouter {
    private openai;
    private topics;
    private confidenceThreshold;
    constructor(config: CallRouterConfig);
    hasTopics(): boolean;
    getTopic(id: string): EventTopic | undefined;
    /**
     * Classify a caller's utterance against the configured topic registry.
     * Returns the best matching topic (if any) along with a 0-1 confidence
     * score. Returns { topic: null } when nothing meets the confidence
     * threshold, so the caller can be given a graceful fallback response.
     */
    classify(utterance: string): Promise<RoutingDecision>;
    /**
     * Produce an answer to the caller's question for the given topic.
     * Prefers the topic's mcpEndpoint (a simple HTTP JSON contract:
     * POST { question } -> { answer }) and falls back to a knowledge-grounded
     * completion using the topic's static `knowledge` text.
     */
    answer(topic: EventTopic, question: string): Promise<string>;
    private answerFromMcpEndpoint;
    private answerFromKnowledge;
}
//# sourceMappingURL=call-router.d.ts.map