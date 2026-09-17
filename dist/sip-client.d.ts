import { SIPAdvancedConfig, CallConfig, CallEvent } from "./types.js";
export declare class SIPClient {
    private userAgent;
    private config;
    private currentSession;
    private eventCallback;
    private mediaHandler;
    private presetRtpPort;
    private keepAliveTimer;
    private connectionState;
    private isLocalHangup;
    private inboundEnabled;
    private autoAnswerInbound;
    constructor(config: SIPAdvancedConfig, eventCallback: (event: CallEvent) => void);
    private validateProviderRequirements;
    getExternalIp(): string | undefined;
    connect(): Promise<void>;
    private buildSipjsConfiguration;
    private buildNATConfiguration;
    private buildSessionConfiguration;
    private buildTransportConfiguration;
    private buildAuthConfiguration;
    private applyProviderQuirks;
    /**
     * Enable handling of inbound (caller-originated) INVITE requests.
     * Can be called before or after connect(); takes effect as soon as the
     * SIP user agent is registered and receiving traffic.
     */
    enableInboundCalls(autoAnswer?: boolean): void;
    disableInboundCalls(): void;
    private setupEventHandlers;
    private handleIncomingInvite;
    /**
     * Accept a pending incoming call. Used automatically when auto-answer is
     * enabled, or can be called manually after receiving an INCOMING_CALL event.
     */
    answerIncomingCall(): Promise<void>;
    /**
     * Reject a pending incoming call before it has been answered.
     */
    rejectIncomingCall(statusCode?: number): Promise<void>;
    private handleRegistrationError;
    private handleProviderSpecificError;
    private handleAsteriskError;
    private handleCiscoError;
    private handleFritzBoxError;
    private handleTransportFallback;
    private patchSipLibraryLogging;
    private startKeepalive;
    private sendKeepalive;
    private stopKeepalive;
    makeCall(callConfig: CallConfig): Promise<string>;
    /**
     * Wire up the common session lifecycle events shared by both outbound
     * (UAC, via makeCall) and inbound (UAS, via handleIncomingInvite) sessions.
     * The underlying "accepted" event (fired for outbound calls once the
     * remote party answers with a 2xx response) and inbound-specific
     * confirmation happen at different points in the SIP handshake, so
     * inbound sessions additionally get an explicit CALL_ANSWERED emission
     * once we've accepted the call (see answerIncomingCall()).
     */
    private attachSessionHandlers;
    private emitCallAnswered;
    private handleCallEnd;
    endCall(): Promise<void>;
    isConnected(): boolean;
    getCurrentCallId(): string | null;
    getCurrentSession(): any;
    setLocalRtpPort(port: number): void;
    setRemoteRtpInfo(ip: string, port: number, session?: any): void;
    disconnect(): Promise<void>;
}
//# sourceMappingURL=sip-client.d.ts.map