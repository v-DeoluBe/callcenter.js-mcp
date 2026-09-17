import { EventEmitter } from "events";
import { networkInterfaces } from "os";
import { SIPClient } from "./sip-client.js";
import { OpenAIClient } from "./openai-client.js";
import { AudioBridge } from "./audio-bridge.js";
import { Config, CallConfig, CallEvent, InboundConfig, EventTopic } from "./types.js";
import { PerformanceMonitor } from "./performance-monitor.js";
import { ConnectionManager } from "./connection-manager.js";
import { CallRouter } from "./call-router.js";
import { getLogger } from "./logger.js";

export class VoiceAgent extends EventEmitter {
  private sipClient: SIPClient;
  private openaiClient: OpenAIClient;
  private audioBridge: AudioBridge;
  private config: Config;
  private connectionManager?: ConnectionManager;
  private isCallActive: boolean = false;
  private currentCallId: string | null = null;
  private perfMonitor: PerformanceMonitor;
  private enableCallRecording: boolean = true;
  private aiEndCallReason: string | null = null;

  // Inbound call routing ("MCP topic" answering) support
  private inboundConfig?: InboundConfig;
  private callRouter?: CallRouter;
  private isInboundCallInProgress: boolean = false;
  
  // Audio batching to reduce OpenAI SDK overhead
  private audioBatch: Int16Array[] = [];
  private readonly BATCH_SIZE = 2; // Batch only 2 packets (20ms) to reduce latency
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_TIMEOUT_MS = 20; // Force send after 20ms for lower latency

  constructor(config: Config, options?: { enableCallRecording?: boolean; recordingFilename?: string }) {
    super();
    this.config = config;
    this.enableCallRecording = options?.enableCallRecording ?? false;

    // Determine if we're using enhanced configuration with ConnectionManager
    const sipConfig = config.sip;
    const aiConfig = config.ai || config.openai;
    
    if (!aiConfig) {
      throw new Error('AI configuration is required (either ai or openai section)');
    }
    
    this.sipClient = new SIPClient(sipConfig, this.handleSipEvent.bind(this));
    this.openaiClient = new OpenAIClient(aiConfig);
    
    // Initialize ConnectionManager if using enhanced config
    if (this.isEnhancedConfig(config)) {
      this.connectionManager = new ConnectionManager(config.sip as any);
      this.setupConnectionManager();
    }

    // Set up inbound call routing if configured
    if (config.inbound?.enabled) {
      this.inboundConfig = config.inbound;
      this.callRouter = new CallRouter({
        openaiApiKey: aiConfig.openaiApiKey,
        topics: config.inbound.topics || [],
        confidenceThreshold: config.inbound.confidenceThreshold,
      });
    }

    // Get the local IP for binding
    const localIp = this.getLocalIpAddress();
    this.audioBridge = new AudioBridge({
      localRtpPort: 0, // Let OS choose port
      localRtpHost: localIp, // Bind to the same IP we advertise in SDP
      sampleRate: 24000,
      enableCallRecording: this.enableCallRecording,
      recordingFilename: options?.recordingFilename,
    });

    this.setupAudioBridge();
    this.setupInboundRouting();
    
    // Initialize performance monitoring
    this.perfMonitor = new PerformanceMonitor();
    this.perfMonitor.on('eventLoopLag', (lag: number) => {
      if (lag > 100) {
        getLogger().perf.warn(`Severe event loop lag detected: ${lag.toFixed(2)}ms`);
      }
    });
  }

  private isEnhancedConfig(config: Config): boolean {
    return 'sip' in config && typeof (config.sip as any)._providerProfile !== 'undefined';
  }

  private setupConnectionManager(): void {
    if (!this.connectionManager) return;

    this.connectionManager.on('stateChange', (state) => {
      getLogger().sip.debug(`Connection state changed: ${state.status}`);
      this.emit('connectionStateChange', state);
    });

    this.connectionManager.on('connected', () => {
      getLogger().sip.debug('ConnectionManager: Connected to SIP server');
    });

    this.connectionManager.on('registered', () => {
      getLogger().sip.debug('ConnectionManager: Registered with SIP server');
    });

    this.connectionManager.on('connectionFailed', (error) => {
      getLogger().sip.error('ConnectionManager: Connection failed:', error.message);
      this.emit('error', error);
    });

    this.connectionManager.on('reconnectAttempt', (attempt) => {
      getLogger().sip.debug(`ConnectionManager: Reconnect attempt ${attempt}`);
      this.emit('reconnectAttempt', attempt);
    });

    this.connectionManager.on('transportFallback', (transport) => {
      getLogger().sip.debug(`ConnectionManager: Transport fallback to ${transport}`);
      this.emit('transportFallback', transport);
    });
  }

  private getLocalIpAddress(): string {
    // Find the local IP address that can reach the Fritz Box
    const interfaces = networkInterfaces();
    
    // Look for non-loopback, IPv4 addresses
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (addrs) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal) {
            getLogger().configLogs.info(`Using local IP address: ${addr.address} (interface: ${name})`);
            return addr.address;
          }
        }
      }
    }
    
    // Fallback to localhost if no external interface found
    getLogger().configLogs.warn('No external IP found, using localhost');
    return '127.0.0.1';
  }

  private setupAudioBridge(): void {
    this.audioBridge.on("audioReceived", (audioData: Int16Array) => {
      if (this.isCallActive && this.openaiClient.isReady()) {
        this.addAudioToBatch(audioData);
      }
    });

    // Listen for RTP timeout events from AudioBridge
    this.audioBridge.on("rtpTimeout", () => {
      if (this.isCallActive) {
        getLogger().rtp.info("RTP timeout detected - remote party likely hung up");
        this.handleCallEnded('remote');
      }
    });

    this.audioBridge.on("error", (error) => {
      getLogger().audio.error("Audio bridge error:", error);
      this.emit("error", error);
    });

    this.openaiClient.onAudioReceived((audioData: Int16Array, responseId?: string) => {
      if (this.isCallActive && this.audioBridge.isRunning()) {
        this.audioBridge.sendAudio(audioData, responseId);
      }
    });

    // Handle AI-initiated end call
    this.openaiClient.onEndCall(() => {
      if (this.isCallActive) {
        getLogger().ai.info("AI ended the call", 'AI');
        this.endCall();
      }
    });
    
    // Track AI's reason for ending call
    this.openaiClient.on('aiEndCallDecision', (reason: string) => {
      this.aiEndCallReason = reason;
    });

    // Handle response with end_call completing generation - wait for audio to finish
    this.openaiClient.on('responseWithEndCallComplete', (responseId: string) => {
      getLogger().ai.debug(`Response ${responseId} with end_call generated, waiting for audio playback`, 'AI');
      
      // Tell AudioBridge to notify us when this response finishes playing
      this.audioBridge.notifyWhenResponseComplete(responseId, () => {
        getLogger().ai.debug(`Response ${responseId} audio playback complete, executing end_call`, 'AI');
        // First log the queued transcript, then execute end_call
        this.openaiClient.logQueuedTranscript(responseId);
        this.openaiClient.executePendingEndCall();
      });
    });
    
    // Handle regular response completion - set up transcript logging
    this.openaiClient.on('responseGenerated', (responseId: string) => {
      getLogger().ai.debug(`Response ${responseId} generated, setting up transcript logging`, 'AI');
      
      // Tell AudioBridge to notify us when this response finishes playing
      this.audioBridge.notifyWhenResponseComplete(responseId, () => {
        getLogger().ai.debug(`Response ${responseId} audio playback complete, logging queued transcript`, 'AI');
        this.openaiClient.logQueuedTranscript(responseId);
      });
    });

    // Handle cancellation of pending end_call
    this.openaiClient.on('cancelPendingEndCall', () => {
      getLogger().ai.debug('Canceling pending end_call due to user interruption', 'AI');
      this.audioBridge.cancelPendingCallbacks();
    });

    // Handle conversation interruptions
    this.openaiClient.on('conversationInterrupted', () => {
      getLogger().ai.debug('User interrupted - stopping audio playback');
      this.clearAudioBatch(); // Clear any pending audio batch
      if (this.audioBridge.isRunning()) {
        this.audioBridge.clearAudioBuffer();
      }
    });
    
    // Handle playback position requests for accurate truncation
    this.openaiClient.on('getPlaybackPosition', (callback: (position: number) => void) => {
      if (this.audioBridge.isRunning()) {
        // Get the current playback position of the currently playing response
        const position = this.audioBridge.getCurrentPlaybackPosition();
        callback(position);
      } else {
        callback(0);
      }
    });
    
    // Handle requests for the currently playing response ID
    this.openaiClient.on('getPlayingResponseId', (callback: (responseId: string | null) => void) => {
      if (this.audioBridge.isRunning()) {
        // Get the currently playing response ID from AudioBridge
        const playingResponseId = this.audioBridge.getCurrentlyPlayingResponseId();
        callback(playingResponseId);
      } else {
        callback(null);
      }
    });
  }

  /**
   * Wire up caller-question routing for inbound calls: whenever the caller's
   * speech has been transcribed, classify it against the configured topic
   * registry and inject a grounded answer into the AI's instructions before
   * generating a response.
   */
  private setupInboundRouting(): void {
    if (!this.callRouter) return;

    this.openaiClient.on('userTranscriptCompleted', (transcript: string) => {
      if (this.isCallActive && this.isInboundCallInProgress) {
        this.handleInboundQuestion(transcript);
      }
    });
  }

  private async handleInboundQuestion(transcript: string): Promise<void> {
    if (!this.callRouter || !this.inboundConfig) return;

    const question = transcript.trim();
    if (!question) return;

    try {
      getLogger().ai.debug(`Routing inbound caller question: "${question}"`, 'AI');
      const decision = await this.callRouter.classify(question);

      let instructions: string;
      if (decision.topic) {
        const answer = await this.callRouter.answer(decision.topic, question);
        const timestamp = getLogger().isQuietMode() ? `[${new Date().toTimeString().substring(0, 8)}] ` : '';
        getLogger().callStatus.transcript(
          `${timestamp}🔀 Routed to topic "${decision.topic.name}" (confidence: ${decision.confidence.toFixed(2)})`
        );
        instructions = this.buildRoutedInstructions(decision.topic, answer);
      } else {
        instructions = this.buildNoMatchInstructions();
      }

      this.openaiClient.updateInstructions(instructions);
    } catch (error) {
      getLogger().ai.error(
        'Error routing inbound question:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      if (this.isCallActive) {
        this.openaiClient.createResponse();
      }
    }
  }

  private buildGreetingInstructions(): string {
    const topics = this.inboundConfig?.topics || [];
    const topicList = topics.map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const greeting =
      this.inboundConfig?.greeting ||
      "Hello! Thanks for calling. What would you like to know about?";

    return (
      `You are a friendly phone assistant answering an inbound information line. ` +
      `Start the call by greeting the caller with: "${greeting}" Then listen carefully to their question. ` +
      (topicList
        ? `You can help answer questions about the following topics/events:\n${topicList}\n`
        : '') +
      `Keep responses brief and conversational, since this is a live phone call. ` +
      `Do not make up information you don't have.`
    );
  }

  private buildRoutedInstructions(topic: EventTopic, answer: string): string {
    return (
      `You are a friendly phone assistant answering an inbound information line. ` +
      `The caller just asked a question related to "${topic.name}". ` +
      `Speak the following answer back to them naturally and conversationally (don't read it verbatim, rephrase it as natural speech):\n\n` +
      `"${answer}"\n\n` +
      `After answering, ask if there's anything else they'd like to know. Keep responses brief, as this is a live phone call.`
    );
  }

  private buildNoMatchInstructions(): string {
    const noMatchMessage =
      this.inboundConfig?.noMatchMessage ||
      "I'm sorry, I don't have information on that topic.";

    return (
      `You are a friendly phone assistant answering an inbound information line. ` +
      `You don't have specific information to answer the caller's last question. ` +
      `Politely tell them: "${noMatchMessage}" Then ask if there's anything else you can help with. ` +
      `Keep responses brief, as this is a live phone call.`
    );
  }

  private addAudioToBatch(audioData: Int16Array): void {
    this.audioBatch.push(audioData);

    // Send immediately if batch is full
    if (this.audioBatch.length >= this.BATCH_SIZE) {
      this.sendBatchedAudio();
      return;
    }

    // Set timeout to force send if batch isn't full
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.sendBatchedAudio();
      }, this.BATCH_TIMEOUT_MS);
    }
  }

  private sendBatchedAudio(): void {
    if (this.audioBatch.length === 0) return;

    // Clear timeout if active
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Merge the batched audio arrays
    const totalLength = this.audioBatch.reduce((sum, arr) => sum + arr.length, 0);
    const mergedAudio = new Int16Array(totalLength);
    let offset = 0;
    
    for (const audioData of this.audioBatch) {
      mergedAudio.set(audioData, offset);
      offset += audioData.length;
    }

    // Send to OpenAI
    this.openaiClient.sendAudio(mergedAudio);

    // Clear batch
    this.audioBatch = [];
  }

  private clearAudioBatch(): void {
    this.audioBatch = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private handleSipEvent(event: CallEvent): void {
    getLogger().sip.debug("SIP Event:", event.type);
    this.emit("sipEvent", event);

    // Notify ConnectionManager of relevant events
    if (this.connectionManager) {
      switch (event.type) {
        case "REGISTERED":
          this.connectionManager.onRegistered();
          break;
        case "DISCONNECTED":
          this.connectionManager.onDisconnected();
          break;
      }
    }

    switch (event.type) {
      case "REGISTERED":
        getLogger().sip.debug("SIP client registered successfully");
        break;
      case "INCOMING_CALL": {
        this.isInboundCallInProgress = true;
        const timestamp = getLogger().isQuietMode() ? `[${new Date().toTimeString().substring(0, 8)}] ` : '';
        getLogger().callStatus.transcript(`${timestamp}📞 INCOMING CALL from ${event.data?.from || 'unknown'}`);
        this.emit("incomingCall", event.data);
        break;
      }
      case "CALL_ANSWERED":
        this.handleCallAnswered(event);
        break;
      case "CALL_ENDED":
        this.handleCallEnded(event.endedBy || 'remote');
        break;
      case "REGISTER_FAILED":
        getLogger().sip.error("SIP registration failed:", event.message);
        break;
      case "DISCONNECTED":
        getLogger().sip.debug("SIP client disconnected");
        break;
    }
  }

  private async handleCallAnswered(event: CallEvent): Promise<void> {
    const callData = event.data;
    
    // Always process codec negotiation and RTP settings, even for subsequent CALL_ANSWERED events
    const remoteRtpIp = callData.remoteRtpIp;
    const remoteRtpPort = callData.remoteRtpPort;
    const negotiatedPayloadType = callData.negotiatedPayloadType;

    if (negotiatedPayloadType !== undefined && negotiatedPayloadType !== null) {
      this.audioBridge.setNegotiatedCodec(negotiatedPayloadType);
    }

    if (remoteRtpIp && remoteRtpPort) {
      getLogger().rtp.debug(
        `Setting up RTP connection to ${remoteRtpIp}:${remoteRtpPort}`
      );
      this.audioBridge.setRemoteEndpoint(remoteRtpIp, remoteRtpPort);
      // Start RTP timeout detection for call termination
      this.audioBridge.startRtpDetection();
    }

    // Only do initial setup if this is the first CALL_ANSWERED event
    if (!this.isCallActive) {
      this.isCallActive = true;
      getLogger().sip.debug("Call answered, connecting to OpenAI and setting up audio");
      
      // Always log call established to transcript channel for MCP servers
      const timestamp = getLogger().isQuietMode() ? `[${new Date().toTimeString().substring(0, 8)}] ` : '';
      getLogger().callStatus.transcript(`${timestamp}📞 CALL ESTABLISHED`);
      
      // Start performance monitoring when call begins
      this.perfMonitor.startMonitoring();
      
      // Log system stats every 30 seconds during call
      const statsInterval = setInterval(() => {
        if (this.isCallActive) {
          this.perfMonitor.logStats();
        } else {
          clearInterval(statsInterval);
        }
      }, 30000);

      try {
        // For inbound calls being routed to topic-specific knowledge, use a
        // greeting-focused prompt and take manual control of response
        // generation so we can inject a routed answer before the AI speaks.
        if (this.callRouter && this.isInboundCallInProgress) {
          this.openaiClient.setManualResponseControl(true);
          this.openaiClient.updateInstructions(this.buildGreetingInstructions());
        } else {
          this.openaiClient.setManualResponseControl(false);
        }

        if (!this.openaiClient.isReady()) {
          await this.openaiClient.connect();
        }

        setTimeout(() => {
          // Trigger initial response using configured instructions (no text input)
          this.openaiClient.createResponse();
        }, 1000);
      } catch (error) {
        getLogger().sip.error("Error setting up call:", error);
        this.emit("error", error);
      }
    } else {
      getLogger().rtp.debug("Updating codec/RTP settings for active call");
    }
  }

  private parseSdpAndSetupAudio(sdp: string): void {
    try {
      const lines = sdp.split("\n");
      let remoteHost: string | null = null;
      let remotePort: number | null = null;

      for (const line of lines) {
        if (line.startsWith("c=IN IP4 ")) {
          remoteHost = line.split(" ")[2].trim();
        }
        if (line.startsWith("m=audio ")) {
          const parts = line.split(" ");
          remotePort = parseInt(parts[1]);
        }
      }

      if (remoteHost && remotePort) {
        this.audioBridge.setRemoteEndpoint(remoteHost, remotePort);
        getLogger().rtp.debug(`Audio setup: ${remoteHost}:${remotePort}`);
      }
    } catch (error) {
      getLogger().rtp.error("Error parsing SDP:", error);
    }
  }

  private async handleCallEnded(endedBy: 'remote' | 'local' = 'local'): Promise<void> {
    this.isCallActive = false;
    this.currentCallId = null;
    this.isInboundCallInProgress = false;
    
    // Determine who really ended the call and why
    let endedByText: string;
    if (this.aiEndCallReason) {
      // AI ended the call - show the reason
      endedByText = `AI (${this.aiEndCallReason})`;
      getLogger().sip.debug(`Call ended by AI: ${this.aiEndCallReason}`);
    } else if (endedBy === 'remote') {
      endedByText = 'remote party';
      getLogger().sip.debug(`Call ended by remote party`);
    } else {
      endedByText = 'local user';
      getLogger().sip.debug(`Call ended by local user`);
    }
    
    // Always log call ended to transcript channel for MCP servers
    const timestamp = getLogger().isQuietMode() ? `[${new Date().toTimeString().substring(0, 8)}] ` : '';
    getLogger().callStatus.transcript(`${timestamp}📞 CALL ENDED by ${endedByText}`);
    
    // Reset the AI end call reason for next call
    this.aiEndCallReason = null;
    
    // Clear any pending audio batch
    this.clearAudioBatch();
    
    // Stop performance monitoring
    this.perfMonitor.stopMonitoring();

    try {
      await this.openaiClient.disconnect();
      this.audioBridge.stop();
    } catch (error) {
      getLogger().error("Error cleaning up after call:", error instanceof Error ? error.message : String(error));
    }

    this.emit("callEnded");
  }

  async initialize(): Promise<void> {
    getLogger().info("Initializing voice agent...", "CONFIG");

    try {
      if (this.connectionManager) {
        // Use ConnectionManager for enhanced connection handling
        getLogger().sip.debug("Using ConnectionManager for SIP connection...");
        await this.connectionManager.connect(this.sipClient);
      } else {
        // Fallback to direct connection for legacy config
        getLogger().sip.debug("Using direct SIP connection (legacy mode)...");
        await this.sipClient.connect();
      }
      getLogger().info("Voice agent initialized successfully", "CONFIG");
    } catch (error) {
      getLogger().error("Failed to initialize voice agent:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Register with the SIP provider (if not already connected) and start
   * accepting inbound calls, routing caller questions to the configured
   * topic registry. Requires `config.inbound.enabled` to be true.
   */
  async listenForCalls(): Promise<void> {
    if (!this.inboundConfig?.enabled || !this.callRouter) {
      throw new Error(
        "Inbound call handling is not enabled. Set `inbound.enabled = true` and provide `inbound.topics` in the configuration."
      );
    }

    // Start AudioBridge up-front so an RTP port is ready before the first
    // INVITE arrives (outbound calls start it lazily inside makeCall()).
    if (!this.audioBridge.isRunning()) {
      await this.audioBridge.start();
      getLogger().audio.debug(
        `AudioBridge started on port: ${this.audioBridge.getLocalPort()}`
      );
      this.sipClient.setLocalRtpPort(this.audioBridge.getLocalPort());
    }

    const autoAnswer = this.inboundConfig.autoAnswer !== false;
    this.sipClient.enableInboundCalls(autoAnswer);

    if (!this.sipClient.isConnected()) {
      await this.initialize();
    }

    getLogger().sip.info(
      `Listening for inbound calls (auto-answer: ${autoAnswer}, topics: ${this.inboundConfig.topics.length})`
    );
  }

  async makeCall(callConfig: CallConfig): Promise<void> {
    if (!this.sipClient.isConnected()) {
      throw new Error("SIP client not connected");
    }

    if (this.isCallActive) {
      throw new Error("Call already in progress");
    }

    getLogger().sip.debug(`Making call to ${callConfig.targetNumber}`);

    try {
      // Start AudioBridge first to get the actual RTP port
      if (!this.audioBridge.isRunning()) {
        await this.audioBridge.start();
        getLogger().audio.debug(
          `AudioBridge started on port: ${this.audioBridge.getLocalPort()}`
        );

        // Update SIP client with the actual RTP port
        this.sipClient.setLocalRtpPort(this.audioBridge.getLocalPort());
      }

      this.currentCallId = await this.sipClient.makeCall(callConfig);
      this.emit("callInitiated", {
        callId: this.currentCallId,
        target: callConfig.targetNumber,
      });
    } catch (error) {
      getLogger().sip.error("Failed to make call:", error);
      throw error;
    }
  }

  async endCall(): Promise<void> {
    if (!this.isCallActive) {
      getLogger().sip.debug("No active call to end");
      return;
    }

    getLogger().sip.debug("Ending call...");

    try {
      await this.sipClient.endCall();
    } catch (error) {
      getLogger().sip.error("Error ending call:", error);
      throw error;
    }
  }

  getStatus(): any {
    const baseStatus = {
      sipConnected: this.sipClient.isConnected(),
      aiConnected: this.openaiClient.isReady(),
      audioBridgeActive: this.audioBridge.isRunning(),
      callActive: this.isCallActive,
      currentCallId: this.currentCallId,
    };

    // Add ConnectionManager status if available
    if (this.connectionManager) {
      return {
        ...baseStatus,
        connectionManager: {
          status: this.connectionManager.currentState.status,
          reconnectAttempts: this.connectionManager.currentState.reconnectAttempts,
          currentTransport: this.connectionManager.currentState.currentTransport,
          providerProfile: this.connectionManager.currentState.providerProfile?.name,
        }
      };
    }

    return baseStatus;
  }

  async shutdown(): Promise<void> {
    getLogger().info("Shutting down voice agent...", "CONFIG");

    if (this.isCallActive) {
      await this.endCall();
    }

    // Clear any pending audio batch
    this.clearAudioBatch();

    try {
      await this.openaiClient.disconnect();
      this.audioBridge.stop();
      await this.sipClient.disconnect();
      this.perfMonitor.stopMonitoring();
      
      // Clean up ConnectionManager
      if (this.connectionManager) {
        this.connectionManager.destroy();
      }
    } catch (error) {
      getLogger().error("Error during shutdown:", error instanceof Error ? error.message : String(error));
    }

    getLogger().info("Voice agent shut down");
  }
}
