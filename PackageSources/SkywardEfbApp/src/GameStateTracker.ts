type TrackerCaptureSource = "event" | "snapshot" | "hydrate" | "cache";

export interface GameStateReading {
    gameMode: number;
    isInMenu: boolean;
    label: string;
    source: TrackerCaptureSource;
    gameModeTrusted: boolean;
    isInMenuTrusted: boolean;
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
    private static _instance?: GameStateTracker;

    private manager?: GameModeManagerLike;
    private bus?: unknown;
    private gameModeSub?: { destroy: () => void };
    private isInMenuSub?: { destroy: () => void };
    private retryTimer?: number;
    private hydrateAttempted = false;
    private hasSeenGameModeEvent = false;
    private hasSeenIsInMenuEvent = false;
    private lastTrustedGameMode?: number;
    private currentReading?: GameStateReading;
    private readonly listeners = new Set<TrackerListener>();

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
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            if (!this.bindManager()) {
                this.scheduleRetry();
            }
        }, 500);
    }

    private bindManager(): boolean {
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
        void this.tryHydrateCurrentGameMode();
        return true;
    }

    private async tryHydrateCurrentGameMode(): Promise<void> {
        if (this.hydrateAttempted) {
            return;
        }
        this.hydrateAttempted = true;

        const request = window.Databinding?.context?.stateInfo?.getGamemode?.request;
        if (typeof request !== "function") {
            return;
        }

        try {
            const value = await request("");
            const normalized = this.normalizeHydratedGameMode(value);
            if (normalized === undefined) {
                return;
            }
            this.lastTrustedGameMode = normalized;
            this.publish("hydrate");
        } catch {
            // Ignore optional hydration failures; event subscriptions remain active.
        }
    }

    private publish(source: TrackerCaptureSource): void {
        const reading = this.readCurrent(source);
        if (!reading) {
            return;
        }

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
}
