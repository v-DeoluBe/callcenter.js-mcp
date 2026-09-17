import { EventEmitter } from "events";
import { Config, CallConfig } from "./types.js";
export declare class VoiceAgent extends EventEmitter {
    private sipClient;
    private openaiClient;
    private audioBridge;
    private config;
    private connectionManager?;
    private isCallActive;
    private currentCallId;
    private perfMonitor;
    private enableCallRecording;
    private aiEndCallReason;
    private inboundConfig?;
    private callRouter?;
    private isInboundCallInProgress;
    private audioBatch;
    private readonly BATCH_SIZE;
    private batchTimer;
    private readonly BATCH_TIMEOUT_MS;
    constructor(config: Config, options?: {
        enableCallRecording?: boolean;
        recordingFilename?: string;
    });
    private isEnhancedConfig;
    private setupConnectionManager;
    private getLocalIpAddress;
    private setupAudioBridge;
    /**
     * Wire up caller-question routing for inbound calls: whenever the caller's
     * speech has been transcribed, classify it against the configured topic
     * registry and inject a grounded answer into the AI's instructions before
     * generating a response.
     */
    private setupInboundRouting;
    private handleInboundQuestion;
    private buildGreetingInstructions;
    private buildRoutedInstructions;
    private buildNoMatchInstructions;
    private addAudioToBatch;
    private sendBatchedAudio;
    private clearAudioBatch;
    private handleSipEvent;
    private handleCallAnswered;
    private parseSdpAndSetupAudio;
    private handleCallEnded;
    initialize(): Promise<void>;
    /**
     * Register with the SIP provider (if not already connected) and start
     * accepting inbound calls, routing caller questions to the configured
     * topic registry. Requires `config.inbound.enabled` to be true.
     */
    listenForCalls(): Promise<void>;
    makeCall(callConfig: CallConfig): Promise<void>;
    endCall(): Promise<void>;
    getStatus(): any;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=voice-agent.d.ts.map