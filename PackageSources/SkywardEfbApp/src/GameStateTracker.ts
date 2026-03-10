type TrackerCaptureSource = "event" | "snapshot" | "hydrate" | "cache";
type TrackerDebugReason =
    | TrackerCaptureSource
    | "initialize"
    | "bind_attempt"
    | "bind_success"
    | "bind_retry"
    | "hydrate_retry"
    | "hydrate_attempt"
    | "hydrate_missing_request"
    | "hydrate_success"
    | "hydrate_failed";

export interface GameStateReading {
    gameMode: number;
    isInMenu: boolean;
    label: string;
    source: TrackerCaptureSource;
    gameModeTrusted: boolean;
    isInMenuTrusted: boolean;
}

export interface GameStateTrackerDebugEntry {
    tsMs: number;
    reason: TrackerDebugReason;
    source?: TrackerCaptureSource;
    rawGameMode?: number;
    rawIsInMenu?: boolean;
    effectiveGameMode?: number;
    effectiveIsInMenu?: boolean;
    effectiveLabel?: string;
    gameModeTrusted?: boolean;
    isInMenuTrusted?: boolean;
    hasSeenGameModeEvent: boolean;
    hasSeenIsInMenuEvent: boolean;
    lastTrustedGameMode?: number;
    hydrateAttempted: boolean;
    hydrateRequestAvailable: boolean;
    note?: string;
}

export interface GameStateTrackerDebugSnapshot {
    initializedAtMs: number;
    managerBoundAtMs?: number;
    bindAttemptCount: number;
    bindSuccessCount: number;
    bindRetryCount: number;
    hydrateAttempted: boolean;
    hydrateInFlight: boolean;
    hydrateLastAttemptAtMs?: number;
    hydrateRequestAvailable: boolean;
    hydrateRetryScheduled: boolean;
    hydrateSucceeded: boolean;
    hydrateFailedCount: number;
    hydrateLastResultRaw?: string;
    hydrateLastResultNormalized?: number;
    hasSeenGameModeEvent: boolean;
    hasSeenIsInMenuEvent: boolean;
    lastTrustedGameMode?: number;
    lastRawGameMode?: number;
    lastRawIsInMenu?: boolean;
    currentReading?: GameStateReading;
    history: GameStateTrackerDebugEntry[];
}

type TrackerListener = (reading: GameStateReading) => void;

interface SubjectLike<T> {
    sub: (handler: (value: T) => void) => { destroy: () => void };
    get?: () => T | undefined;
    getValue?: () => T | undefined;
}

interface GameModeManagerLike {
    gameMode?: SubjectLike<number>;
    isInMenu?: SubjectLike<boolean>;
    setBus?: (bus: unknown) => void;
}

interface DatabindingRouteLike {
    request?: (payload?: string) => Promise<unknown>;
}

interface DatabindingLike {
    context?: {
        stateInfo?: {
            getGamemode?: DatabindingRouteLike;
        };
    };
}

declare global {
    interface Window {
        GAME_MODE_MANAGER: GameModeManagerLike | undefined;
        Databinding: DatabindingLike | undefined;
    }
}

export class GameStateTracker {
    private static readonly DEBUG_HISTORY_LIMIT = 25;
    private static readonly HYDRATE_RETRY_MS = 1000;
    private static _instance?: GameStateTracker;

    private manager?: GameModeManagerLike;
    private bus?: unknown;
    private gameModeSub?: { destroy: () => void };
    private isInMenuSub?: { destroy: () => void };
    private retryTimer?: number;
    private hydrateRetryTimer?: number;
    private hydrateInFlight = false;
    private hydrateAttempted = false;
    private hasSeenGameModeEvent = false;
    private hasSeenIsInMenuEvent = false;
    private lastTrustedGameMode?: number;
    private currentReading?: GameStateReading;
    private readonly listeners = new Set<TrackerListener>();
    private readonly initializedAtMs = Date.now();
    private managerBoundAtMs?: number;
    private bindAttemptCount = 0;
    private bindSuccessCount = 0;
    private bindRetryCount = 0;
    private hydrateLastAttemptAtMs?: number;
    private hydrateRequestAvailable = false;
    private hydrateSucceeded = false;
    private hydrateFailedCount = 0;
    private hydrateLastResultRaw?: string;
    private hydrateLastResultNormalized?: number;
    private lastRawGameMode?: number;
    private lastRawIsInMenu?: boolean;
    private readonly debugHistory: GameStateTrackerDebugEntry[] = [];

    public static get instance(): GameStateTracker {
        if (!GameStateTracker._instance) {
            GameStateTracker._instance = new GameStateTracker();
        }
        return GameStateTracker._instance;
    }

    public initialize(bus: unknown): void {
        this.bus = bus;
        if (this.bindManager()) {
            return;
        }
        this.scheduleRetry();
    }

    public getCurrentReading(): GameStateReading | undefined {
        return this.currentReading;
    }

    public getDebugSnapshot(): GameStateTrackerDebugSnapshot {
        return {
            initializedAtMs: this.initializedAtMs,
            managerBoundAtMs: this.managerBoundAtMs,
            bindAttemptCount: this.bindAttemptCount,
            bindSuccessCount: this.bindSuccessCount,
            bindRetryCount: this.bindRetryCount,
            hydrateAttempted: this.hydrateAttempted,
            hydrateInFlight: this.hydrateInFlight,
            hydrateLastAttemptAtMs: this.hydrateLastAttemptAtMs,
            hydrateRequestAvailable: this.hydrateRequestAvailable,
            hydrateRetryScheduled: this.hydrateRetryTimer !== undefined,
            hydrateSucceeded: this.hydrateSucceeded,
            hydrateFailedCount: this.hydrateFailedCount,
            hydrateLastResultRaw: this.hydrateLastResultRaw,
            hydrateLastResultNormalized: this.hydrateLastResultNormalized,
            hasSeenGameModeEvent: this.hasSeenGameModeEvent,
            hasSeenIsInMenuEvent: this.hasSeenIsInMenuEvent,
            lastTrustedGameMode: this.lastTrustedGameMode,
            lastRawGameMode: this.lastRawGameMode,
            lastRawIsInMenu: this.lastRawIsInMenu,
            currentReading: this.currentReading,
            history: [...this.debugHistory],
        };
    }

    public sub(listener: TrackerListener): { destroy: () => void } {
        this.listeners.add(listener);
        if (this.currentReading) {
            listener(this.currentReading);
        }
        return {
            destroy: () => {
                this.listeners.delete(listener);
            },
        };
    }

    private scheduleRetry(): void {
        if (this.retryTimer !== undefined) {
            return;
        }
        this.bindRetryCount += 1;
        this.pushDebugEntry("bind_retry", "manager unavailable; retry scheduled");
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            if (!this.bindManager()) {
                this.scheduleRetry();
            }
        }, 500);
    }

    private bindManager(): boolean {
        this.bindAttemptCount += 1;
        this.pushDebugEntry("bind_attempt");
        const manager = window.GAME_MODE_MANAGER;
        if (
            !manager
            || !manager.gameMode
            || !manager.isInMenu
            || typeof manager.gameMode.sub !== "function"
            || typeof manager.isInMenu.sub !== "function"
        ) {
            return false;
        }

        if (this.manager === manager && this.gameModeSub && this.isInMenuSub) {
            return true;
        }

        this.manager = manager;
        this.managerBoundAtMs = Date.now();
        this.bindSuccessCount += 1;
        this.pushDebugEntry("bind_success");
        if (typeof manager.setBus === "function" && this.bus) {
            manager.setBus(this.bus);
        }

        this.gameModeSub?.destroy();
        this.isInMenuSub?.destroy();

        this.gameModeSub = manager.gameMode.sub((value: number) => {
            this.hasSeenGameModeEvent = true;
            this.lastTrustedGameMode = value;
            this.publish("event");
        });

        this.isInMenuSub = manager.isInMenu.sub((_value: boolean) => {
            this.hasSeenIsInMenuEvent = true;
            this.publish("event");
        });

        this.publish("snapshot");
        this.maybeEnsureHydrate();
        return true;
    }

    private async tryHydrateCurrentGameMode(): Promise<void> {
        if (this.hydrateInFlight) {
            return;
        }
        this.hydrateInFlight = true;
        this.hydrateAttempted = true;
        this.hydrateLastAttemptAtMs = Date.now();
        this.pushDebugEntry("hydrate_attempt");

        const request = window.Databinding?.context?.stateInfo?.getGamemode?.request;
        this.hydrateRequestAvailable = typeof request === "function";
        if (typeof request !== "function") {
            this.pushDebugEntry("hydrate_missing_request", "Databinding request not ready");
            this.scheduleHydrateRetry();
            this.hydrateInFlight = false;
            return;
        }

        try {
            const value = await request("");
            this.hydrateLastResultRaw = this.stringifyDebugValue(value);
            const normalized = this.normalizeHydratedGameMode(value);
            this.hydrateLastResultNormalized = normalized;
            if (normalized === undefined) {
                this.pushDebugEntry("hydrate_failed", "hydrate returned unsupported value");
                this.scheduleHydrateRetry();
                return;
            }
            this.lastTrustedGameMode = normalized;
            this.hydrateSucceeded = true;
            this.pushDebugEntry("hydrate_success", `normalized=${normalized}`);
            this.publish("hydrate");
        } catch {
            this.hydrateFailedCount += 1;
            this.pushDebugEntry("hydrate_failed", "hydrate request threw");
            this.scheduleHydrateRetry();
            // Ignore optional hydration failures; event subscriptions remain active.
        } finally {
            this.hydrateInFlight = false;
            if (this.shouldHydrateCurrentState()) {
                this.scheduleHydrateRetry();
            } else {
                this.clearHydrateRetry();
            }
        }
    }

    private publish(source: TrackerCaptureSource): void {
        const reading = this.readCurrent(source);
        if (!reading) {
            return;
        }
        this.maybeEnsureHydrate();

        const previous = this.currentReading;
        if (
            previous
            && previous.gameMode === reading.gameMode
            && previous.isInMenu === reading.isInMenu
            && previous.gameModeTrusted === reading.gameModeTrusted
            && previous.isInMenuTrusted === reading.isInMenuTrusted
            && previous.source === reading.source
        ) {
            return;
        }

        this.currentReading = reading;
        this.pushDebugEntry(source, undefined, reading);
        this.listeners.forEach(listener => listener(reading));
    }

    private readCurrent(source: TrackerCaptureSource): GameStateReading | undefined {
        const manager = this.manager;
        if (!manager) {
            return undefined;
        }

        const rawGameMode = this.readSubjectValue<number>(manager.gameMode);
        const rawIsInMenu = this.readSubjectValue<boolean>(manager.isInMenu);
        if (typeof rawGameMode !== "number" || typeof rawIsInMenu !== "boolean") {
            return undefined;
        }
        this.lastRawGameMode = rawGameMode;
        this.lastRawIsInMenu = rawIsInMenu;
        if (rawGameMode !== 0) {
            this.lastTrustedGameMode = rawGameMode;
        }

        const gameModeTrusted = this.hasSeenGameModeEvent || rawGameMode !== 0 || this.lastTrustedGameMode !== undefined;
        const isInMenuTrusted = this.hasSeenIsInMenuEvent || rawIsInMenu !== true;
        const gameMode = rawGameMode === 0 && this.lastTrustedGameMode !== undefined ? this.lastTrustedGameMode : rawGameMode;
        const readingSource = rawGameMode === 0 && this.lastTrustedGameMode !== undefined && source !== "hydrate"
            ? "cache"
            : source;

        return {
            gameMode,
            isInMenu: rawIsInMenu,
            label: this.mapGameModeLabel(gameMode),
            source: readingSource,
            gameModeTrusted,
            isInMenuTrusted,
        };
    }

    private readSubjectValue<T>(subject?: SubjectLike<T>): T | undefined {
        if (!subject) {
            return undefined;
        }
        if (typeof subject.get === "function") {
            const value = subject.get();
            if (value !== undefined) {
                return value;
            }
        }
        if (typeof subject.getValue === "function") {
            const value = subject.getValue();
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }

    private normalizeHydratedGameMode(value: unknown): number | undefined {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4) {
            return Math.trunc(value);
        }

        if (typeof value !== "string") {
            return undefined;
        }

        const normalized = value.trim().toUpperCase();
        switch (normalized) {
            case "":
            case "MAIN_MENU":
                return 0;
            case "CAREER":
            case "CAREER GAMEMODE":
                return 1;
            case "CHALLENGE":
            case "CHALLENGE GAMEMODE":
                return 2;
            case "DISCOVERY":
            case "DISCOVERY GAMEMODE":
                return 3;
            case "FREEFLIGHT":
            case "FREEFLIGHT GAMEMODE":
                return 4;
            default:
                return undefined;
        }
    }

    private mapGameModeLabel(gameMode: number): string {
        switch (gameMode) {
            case 0:
                return "";
            case 1:
                return "CAREER GAMEMODE";
            case 2:
                return "CHALLENGE GAMEMODE";
            case 3:
                return "DISCOVERY GAMEMODE";
            case 4:
                return "FREEFLIGHT GAMEMODE";
            default:
                return "UNKNOWN GAMEMODE";
        }
    }

    private pushDebugEntry(
        reason: TrackerDebugReason,
        note?: string,
        reading?: GameStateReading,
    ): void {
        const entry: GameStateTrackerDebugEntry = {
            tsMs: Date.now(),
            reason,
            source: reading?.source,
            rawGameMode: this.lastRawGameMode,
            rawIsInMenu: this.lastRawIsInMenu,
            effectiveGameMode: reading?.gameMode,
            effectiveIsInMenu: reading?.isInMenu,
            effectiveLabel: reading?.label,
            gameModeTrusted: reading?.gameModeTrusted,
            isInMenuTrusted: reading?.isInMenuTrusted,
            hasSeenGameModeEvent: this.hasSeenGameModeEvent,
            hasSeenIsInMenuEvent: this.hasSeenIsInMenuEvent,
            lastTrustedGameMode: this.lastTrustedGameMode,
            hydrateAttempted: this.hydrateAttempted,
            hydrateRequestAvailable: this.hydrateRequestAvailable,
            note,
        };
        this.debugHistory.push(entry);
        if (this.debugHistory.length > GameStateTracker.DEBUG_HISTORY_LIMIT) {
            this.debugHistory.shift();
        }
    }

    private stringifyDebugValue(value: unknown): string {
        if (typeof value === "string") {
            return value;
        }
        if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return Object.prototype.toString.call(value);
        }
    }

    private maybeEnsureHydrate(): void {
        if (!this.shouldHydrateCurrentState()) {
            this.clearHydrateRetry();
            return;
        }
        if (!this.hydrateInFlight) {
            void this.tryHydrateCurrentGameMode();
        }
        this.scheduleHydrateRetry();
    }

    private shouldHydrateCurrentState(): boolean {
        if (!this.manager) {
            return false;
        }
        if (this.lastRawGameMode === 0) {
            return this.lastTrustedGameMode === undefined;
        }
        return this.lastTrustedGameMode === undefined && !this.hasSeenGameModeEvent;
    }

    private scheduleHydrateRetry(): void {
        if (!this.shouldHydrateCurrentState() || this.hydrateRetryTimer !== undefined) {
            return;
        }
        this.pushDebugEntry("hydrate_retry", "hydrate retry scheduled");
        this.hydrateRetryTimer = window.setTimeout(() => {
            this.hydrateRetryTimer = undefined;
            if (!this.shouldHydrateCurrentState()) {
                return;
            }
            void this.tryHydrateCurrentGameMode();
        }, GameStateTracker.HYDRATE_RETRY_MS);
    }

    private clearHydrateRetry(): void {
        if (this.hydrateRetryTimer === undefined) {
            return;
        }
        window.clearTimeout(this.hydrateRetryTimer);
        this.hydrateRetryTimer = undefined;
    }
}
