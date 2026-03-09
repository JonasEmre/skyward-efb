import { GamepadUiView, RequiredProps, TTButton, TVNode, UiViewProps } from "@efb/efb-api";
import { FSComponent } from "@microsoft/msfs-sdk";

declare const SimVar: {
    GetSimVarValue: (name: string, unit: string) => number;
    SetSimVarValue: (name: string, unit: string, value: number) => Promise<void>;
};

type MassBalanceEvent =
    | "MASS_AND_BALANCE_SET"
    | "SEATS_UPDATED"
    | "CARGO_UPDATED"
    | "EMPTY_COG_UPDATED";

interface MassBalanceListener {
    call: (event: string, ...args: unknown[]) => Promise<any>;
    on: (event: MassBalanceEvent, cb: (payload?: any) => void) => void;
}

interface AircraftSelectionListener {
    trigger: (event: string, ...args: unknown[]) => void;
    on: (event: string, cb: (payload?: any) => void) => void;
}

interface FlightPerformanceListener {
    call: (event: string, ...args: unknown[]) => Promise<any>;
}

declare const RegisterViewListener: (
    listenerName: string,
    onRegistered?: () => void
) => MassBalanceListener;
declare const LaunchFlowEventToGlobalFlow: (eventName: string) => void;

interface AddonStatusProps extends RequiredProps<UiViewProps, "appViewService"> { }

interface StatusData {
    simconnect_connected: boolean;
    current_aircraft: string;
    current_airport: string;
    pilot_seat_count?: number;
    copilot_seat_count?: number;
    passenger_seat_count?: number;
    payload_stations?: Record<string, {
        name?: string;
        kind?: PayloadStationKind | null;
        max_weight_lbs?: number | null;
        min_weight_lbs?: number | null;
    }>;
    efb_state_ready?: boolean;
    efb_seq?: number;
    efb_state_debug?: string;
    efb_client_session_id?: string;
    efb_client_started_at_ms?: number;
    efb_last_accepted_seq?: number;
    efb_last_reject_reason?: string;
    efb_heartbeat_interval_ms?: number;
    efb_stale_timeout_ms?: number;
    efb_is_stale?: boolean;
    mission_payload_signal?: {
        id: number;
        target_pax_count: number;
        target_cargo_lbs: number;
        target_baggage_lbs: number;
        avg_pax_lbs: number;
        open_atc: boolean;
        mode: string;
        reason?: string;
    } | null;
}

interface EfbStateResponse {
    ok?: boolean;
    accepted?: boolean;
    reason?: string;
    error?: string;
    active_session_id?: string;
    active_seq?: number;
    canonical_ui_state?: string;
}

type CaptureSource = "event" | "snapshot" | "retry";

interface RawStateSample {
    gameMode: number;
    isInMenu: boolean;
    label: string;
    source: CaptureSource;
    firstSeenAtMs: number;
    lastSeenAtMs: number;
    signature: string;
}

type PayloadStationKind = "pax" | "cargo" | "baggage" | "unknown";

interface PayloadStation {
    id: number;
    name: string;
    kind: PayloadStationKind;
    massLbs: number;
    maxLbs: number;
    minLbs: number;
}

interface SeatStation {
    key: string;
    sectionName: string;
    sectionType: number;
    currentOccupation: number;
    maxOccupation: number;
    massPerSeatLbs: number;
    currentMassLbs: number;
    isPilot: boolean;
    isCopilot: boolean;
    isEditable: boolean;
    isPassengerLoadable: boolean;
}

interface AircraftInfoDetail {
    name?: string;
    value?: number;
    valueStr?: string;
    unit?: string;
    html?: string;
}

interface SelectedPlaneSnapshot {
    displayName?: string;
    variationName?: string;
    details?: AircraftInfoDetail[];
    title?: string;
    atc_title?: string;
    [key: string]: unknown;
}

interface AircraftExportPayload {
    atc_title: string;
    aircraft_info: {
        total_fuel_capacity_gallons: number | null;
        total_fuel_capacity_lbs: number | null;
        fuel_usage_gph: number | null;
        fuel_density: number | null;
        empty_weight_lbs: number | null;
        max_weight_lbs: number | null;
        max_zero_fuel_weight_lbs: number | null;
        max_takeoff_weight_lbs: number | null;
        landing_surface: string | null;
        cruise_speed_knots: number | null;
        max_altitude_feet: number | null;
        range_nm: number | null;
    };
    mass_balance: {
        total_fuel_capacity_gallons: number | null;
        max_zero_fuel_weight_lbs: number | null;
        max_takeoff_weight_lbs: number | null;
        pilot_seat_count: number;
        copilot_seat_count: number;
        passenger_seat_count: number;
        payload_stations: Record<string, {
            name: string;
            kind?: PayloadStationKind | null;
            max_weight_lbs: number | null;
            min_weight_lbs: number | null;
        }>;
        seat_sections: Array<{
            name: string;
            section_type: number;
            capacity: number;
        }>;
    };
    source: {
        current_aircraft_status: string;
    };
}

export class AddonStatus extends GamepadUiView<HTMLDivElement, AddonStatusProps> {
    public readonly tabName = AddonStatus.name;
    private static readonly STATE_CONFIRM_MS = 250;
    private static readonly SNAPSHOT_RETRY_DELAYS_MS = [500, 1500];
    private static readonly DEFAULT_PAX_WEIGHT_LBS = 170;
    private static readonly EFB_STATE_HEARTBEAT_MS = 2000;
    private static readonly MASS_BALANCE_HEARTBEAT_MS = 2000;

    private statusText = FSComponent.createRef<HTMLDivElement>();
    private aircraftText = FSComponent.createRef<HTMLDivElement>();
    private cargoEditors = FSComponent.createRef<HTMLDivElement>();
    private baggageEditors = FSComponent.createRef<HTMLDivElement>();
    private seatEditors = FSComponent.createRef<HTMLDivElement>();
    private seatSummary = FSComponent.createRef<HTMLDivElement>();
    private massSummary = FSComponent.createRef<HTMLDivElement>();
    private payloadPlanner = FSComponent.createRef<HTMLDivElement>();
    private cargoResult = FSComponent.createRef<HTMLDivElement>();
    private gameModeDebug = FSComponent.createRef<HTMLDivElement>();
    private isInMenuDebug = FSComponent.createRef<HTMLDivElement>();
    private postDebug = FSComponent.createRef<HTMLDivElement>();
    private connectionDebug = FSComponent.createRef<HTMLDivElement>();

    private statusTimer?: number;
    private refreshTimer?: number;
    private heartbeatTimer?: number;

    private massBalanceListener?: MassBalanceListener;
    private massBalanceReady = false;
    private aircraftInfoListener?: AircraftSelectionListener;
    private aircraftInfoReady = false;
    private flightPerformanceListener?: FlightPerformanceListener;
    private flightPerformanceReady = false;
    private selectedPlaneSnapshot?: SelectedPlaneSnapshot;
    private aircraftLoadedSub?: { destroy: () => void };
    private cachedFuelUsageGph: number | null = null;
    private cachedFuelDensityLbsPerGallon: number | null = null;

    private gameModeSub?: { destroy: () => void };
    private isInMenuSub?: { destroy: () => void };
    private gameModeManager?: any;
    private gameModeInitRetryTimer?: number;
    private isDestroyed = false;
    private currentGameMode?: number;
    private currentIsInMenu?: boolean;
    private readonly clientStartedAtMs = Date.now();
    private readonly clientSessionId = `efb-${this.clientStartedAtMs}-${Math.random().toString(36).slice(2, 10)}`;
    private efbStateSeq = 0;
    private lastPostedSeq?: number;
    private lastPostedAtMs?: number;
    private pushQueued = false;
    private pushInFlight = false;
    private pendingRepostReason?: string;
    private confirmStateTimer?: number;
    private snapshotRetryTimers: number[] = [];
    private latestRawSample?: RawStateSample;
    private confirmedState?: RawStateSample;
    private lastPublishedSignature?: string;

    private cargoStations: PayloadStation[] = [];
    private baggageStations: PayloadStation[] = [];
    private seatStations: SeatStation[] = [];
    private payloadStationsById = new Map<number, PayloadStationKind>();
    private copilotSeatCount = 0;
    private passengerSeatCount = 0;

    private cargoDraftValues = new Map<number, string>();
    private seatDraftValues = new Map<string, string>();
    private editingCargoIds = new Set<number>();
    private editingSeatKeys = new Set<string>();
    private currentPayloadLbs = 0;
    private currentTowLbs = 0;
    private maxTowLbs = 0;
    private emptyWeightLbs = 0;
    private maxZfwLbs = 0;
    private currentFuelLbs = 0;
    private totalFuelCapacityGallons = 0;
    private safePayloadMaxLbs = 0;
    private maxPaxCapacity = 0;
    private maxCargoCapacityLbs = 0;
    private plannerPercent = 100;
    private plannerIsEditing = false;
    private lastMissionSignalId = 0;
    private pendingMissionSignal?: NonNullable<StatusData["mission_payload_signal"]>;
    private gmStatusText = "GameMode: (init)";
    private menuStatusText = "IsInMenu: (init)";
    private postStatusText = "EFB POST: (pending)";
    private connectionStatusText = "SimConnect timing: (idle)";
    private addonReachable = false;
    private simconnectWasConnected = false;
    private pendingRetryTimer?: number;
    private currentAircraftTitle = "";
    private lastMassBalanceStreamSignature = "";
    private lastMassBalancePostedAtMs?: number;

    public onAfterRender(): void {
        this.fetchStatus();
        this.initMassBalanceListener();
        this.initAircraftInfoListener();
        this.initFlightPerformanceListener();
        this.initGameModeListener();

        this.statusTimer = window.setInterval(() => this.fetchStatus(), 3000);
        this.refreshTimer = window.setInterval(() => this.refreshMassAndBalanceData(), 2000);
        this.heartbeatTimer = window.setInterval(
            () => this.maybeHeartbeatConfirmedState(),
            AddonStatus.EFB_STATE_HEARTBEAT_MS
        );
    }

    public destroy(): void {
        this.isDestroyed = true;
        if (this.statusTimer !== undefined) {
            window.clearInterval(this.statusTimer);
        }
        if (this.refreshTimer !== undefined) {
            window.clearInterval(this.refreshTimer);
        }
        if (this.heartbeatTimer !== undefined) {
            window.clearInterval(this.heartbeatTimer);
        }
        if (this.pendingRetryTimer !== undefined) {
            window.clearTimeout(this.pendingRetryTimer);
        }
        if (this.confirmStateTimer !== undefined) {
            window.clearTimeout(this.confirmStateTimer);
        }
        if (this.gameModeInitRetryTimer !== undefined) {
            window.clearTimeout(this.gameModeInitRetryTimer);
        }
        this.snapshotRetryTimers.forEach(timer => window.clearTimeout(timer));
        if (this.gameModeSub) {
            this.gameModeSub.destroy();
        }
        if (this.isInMenuSub) {
            this.isInMenuSub.destroy();
        }
        if (this.aircraftLoadedSub) {
            this.aircraftLoadedSub.destroy();
        }
        super.destroy();
    }

    private initMassBalanceListener(): void {
        this.massBalanceListener = RegisterViewListener("JS_LISTENER_MASS_AND_BALANCE", () => {
            this.massBalanceReady = true;
            this.refreshMassAndBalanceData();
        });

        const refresh = (): void => {
            this.refreshMassAndBalanceData();
        };

        this.massBalanceListener.on("MASS_AND_BALANCE_SET", refresh);
        this.massBalanceListener.on("SEATS_UPDATED", refresh);
        this.massBalanceListener.on("CARGO_UPDATED", refresh);
        this.massBalanceListener.on("EMPTY_COG_UPDATED", refresh);
    }

    private initAircraftInfoListener(): void {
        this.aircraftInfoListener = RegisterViewListener("JS_LISTENER_AIRCRAFT_SELECTION", () => {
            this.aircraftInfoReady = true;
            this.requestSelectedAircraftInfo();
        }) as unknown as AircraftSelectionListener;

        this.aircraftInfoListener.on("UpdateSelectedPlane", (payload?: unknown) => {
            if (payload && typeof payload === "object") {
                this.selectedPlaneSnapshot = payload as SelectedPlaneSnapshot;
            }
        });

        if (this.props?.appViewService?.bus?.on) {
            this.aircraftLoadedSub = this.props.appViewService.bus.on("AircraftLoaded", () => {
                this.requestSelectedAircraftInfo();
            });
        }
    }

    private requestSelectedAircraftInfo(): void {
        if (!this.aircraftInfoListener || !this.aircraftInfoReady) {
            return;
        }
        try {
            this.aircraftInfoListener.trigger("REQUEST_SELECTED_AIRCRAFT");
        } catch {
            this.setResult("Aircraft info listener request failed.", "#f44336");
        }
    }

    private initFlightPerformanceListener(): void {
        this.flightPerformanceListener = RegisterViewListener("JS_LISTENER_FLIGHT_PERFORMANCE", () => {
            this.flightPerformanceReady = true;
        }) as unknown as FlightPerformanceListener;
    }

    private scheduleGameModeInitRetry(): void {
        if (this.isDestroyed || this.gameModeInitRetryTimer !== undefined || this.gameModeSub || this.isInMenuSub) {
            return;
        }
        this.gameModeInitRetryTimer = window.setTimeout(() => {
            this.gameModeInitRetryTimer = undefined;
            this.initGameModeListener();
        }, 500);
    }

    private initGameModeListener(): void {
        if (this.isDestroyed || this.gameModeSub || this.isInMenuSub) {
            return;
        }
        const gm = (window as any).GAME_MODE_MANAGER;
        if (!gm || !gm.gameMode || !gm.isInMenu || typeof gm.gameMode.sub !== "function" || typeof gm.isInMenu.sub !== "function") {
            this.updateGameModeDebug("GameMode: (manager missing)");
            this.updateIsInMenuDebug("IsInMenu: (manager missing)");
            this.scheduleGameModeInitRetry();
            return;
        }
        this.gameModeManager = gm;
        if (typeof gm.setBus === "function" && this.props?.appViewService?.bus) {
            gm.setBus(this.props.appViewService.bus);
        }

        this.gameModeSub = gm.gameMode.sub((value: number) => {
            this.currentGameMode = value;
            this.captureRawGameState("event", "GameModeChanged");
        });

        this.isInMenuSub = gm.isInMenu.sub((value: boolean) => {
            this.currentIsInMenu = value;
            this.captureRawGameState("event", "IsInMenuUpdate");
        });

        this.captureRawGameState("snapshot", "initial_snapshot");
        AddonStatus.SNAPSHOT_RETRY_DELAYS_MS.forEach(delayMs => {
            const timer = window.setTimeout(() => {
                this.captureRawGameState("retry", `snapshot_retry_${delayMs}`);
            }, delayMs);
            this.snapshotRetryTimers.push(timer);
        });
        this.updatePostDebug("EFB POST: warming up state capture");
    }

    private updateGameModeDebug(text: string): void {
        this.gmStatusText = text;
        if (this.gameModeDebug.instance) {
            this.gameModeDebug.instance.textContent = text;
        }
    }

    private updateIsInMenuDebug(text: string): void {
        this.menuStatusText = text;
        if (this.isInMenuDebug.instance) {
            this.isInMenuDebug.instance.textContent = text;
        }
    }

    private updatePostDebug(text: string): void {
        this.postStatusText = text;
        if (this.postDebug.instance) {
            this.postDebug.instance.textContent = text;
        }
    }

    private updateConnectionDebug(text: string): void {
        this.connectionStatusText = text;
        if (this.connectionDebug.instance) {
            this.connectionDebug.instance.textContent = text;
        }
    }

    private setPayloadStationsFromStatus(payloadStations?: StatusData["payload_stations"]): void {
        this.payloadStationsById.clear();
        if (!payloadStations || typeof payloadStations !== "object") {
            return;
        }
        for (const [stationId, station] of Object.entries(payloadStations)) {
            const normalizedId = Number(stationId);
            const kind = station?.kind;
            if (!Number.isFinite(normalizedId)) {
                continue;
            }
            if (kind === "pax" || kind === "cargo" || kind === "baggage") {
                this.payloadStationsById.set(normalizedId, kind);
            }
        }
    }

    private setSeatCountsFromStatus(data: StatusData): void {
        this.copilotSeatCount = Math.max(0, Math.round(Number(data.copilot_seat_count ?? 0) || 0));
        this.passengerSeatCount = Math.max(0, Math.round(Number(data.passenger_seat_count ?? 0) || 0));
    }

    private isPassengerLoadableSeat(sectionType: number): boolean {
        if (sectionType === 0 || sectionType === 1) {
            return false;
        }
        return true;
    }

    private resolveSeatSectionCapacity(
        section: any,
        seatsArray: Array<{ is_occupied?: boolean }>,
        currentOccupationRaw: number,
        occupiedFromSeatStates: number,
    ): number {
        const candidates = [
            Number(section?.capacity ?? 0),
            Number(section?.max_occupation ?? 0),
            Number(section?.maxOccupation ?? 0),
            Number(section?.configured_occupation ?? 0),
            seatsArray.length,
            currentOccupationRaw,
            occupiedFromSeatStates,
        ]
            .map(value => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0))
            .filter(value => value > 0);

        return candidates.length > 0 ? Math.max(...candidates) : 0;
    }

    private createActionButton(
        label: string,
        onClick: () => void,
        variant: "blue" | "green" | "teal" = "blue",
    ): HTMLButtonElement {
        const palette = {
            blue: {
                background: "linear-gradient(180deg, #3b82f6, #1d4ed8)",
                border: "#60a5fa",
                shadow: "rgba(37, 99, 235, 0.35)",
            },
            green: {
                background: "linear-gradient(180deg, #22c55e, #15803d)",
                border: "#4ade80",
                shadow: "rgba(34, 197, 94, 0.35)",
            },
            teal: {
                background: "linear-gradient(180deg, #14b8a6, #0f766e)",
                border: "#2dd4bf",
                shadow: "rgba(20, 184, 166, 0.35)",
            },
        }[variant];

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.style.height = "36px";
        button.style.padding = "0 14px";
        button.style.background = palette.background;
        button.style.color = "#f8fafc";
        button.style.border = `1px solid ${palette.border}`;
        button.style.borderRadius = "10px";
        button.style.fontSize = "13px";
        button.style.fontWeight = "800";
        button.style.letterSpacing = "0.02em";
        button.style.cursor = "pointer";
        button.style.boxShadow = `0 10px 22px -14px ${palette.shadow}`;
        button.style.transition = "transform 120ms ease, box-shadow 120ms ease, filter 120ms ease";
        button.style.outline = "none";
        button.onmouseenter = (): void => {
            button.style.transform = "translateY(-1px)";
            button.style.filter = "brightness(1.08)";
            button.style.boxShadow = `0 14px 28px -14px ${palette.shadow}`;
        };
        button.onmouseleave = (): void => {
            button.style.transform = "translateY(0)";
            button.style.filter = "none";
            button.style.boxShadow = `0 10px 22px -14px ${palette.shadow}`;
        };
        button.onmousedown = (): void => {
            button.style.transform = "translateY(0)";
            button.style.filter = "brightness(0.98)";
        };
        button.onmouseup = (): void => {
            button.style.transform = "translateY(-1px)";
            button.style.filter = "brightness(1.08)";
        };
        button.onclick = onClick;
        return button;
    }

    private canPostConfirmedState(): boolean {
        return this.confirmedState !== undefined;
    }

    private queuePushEfbState(reason: string, allowDuplicate = false): void {
        if (!this.confirmedState) {
            this.updatePostDebug("EFB POST: waiting for confirmed state");
            return;
        }
        if (
            !allowDuplicate
            && !this.pendingRepostReason
            && this.confirmedState.signature === this.lastPublishedSignature
        ) {
            this.updatePostDebug(`EFB POST: suppressed duplicate confirmed state (${reason})`);
            return;
        }
        this.pushQueued = true;
        if (this.pendingRepostReason && reason !== this.pendingRepostReason) {
            this.updatePostDebug(`EFB POST: confirmed state ready (${reason}; repost pending: ${this.pendingRepostReason})`);
        } else {
            this.updatePostDebug(`EFB POST: confirmed state ready (${reason})`);
        }
        void this.flushPushEfbState();
    }

    private async flushPushEfbState(): Promise<void> {
        if (this.pushInFlight || !this.pushQueued) {
            return;
        }
        if (!this.canPostConfirmedState() || !this.confirmedState) {
            this.updatePostDebug("EFB POST: waiting for confirmed state");
            return;
        }
        this.pushQueued = false;
        this.pushInFlight = true;
        this.efbStateSeq += 1;
        const seq = this.efbStateSeq;
        const sourceTsMs = Date.now();
        const state = this.confirmedState;
        const stabilityMs = Math.max(0, sourceTsMs - state.firstSeenAtMs);
        const canonicalUiState = this.deriveCanonicalUiState(state.gameMode, state.isInMenu);
        try {
            const response = await fetch("http://127.0.0.1:5000/efb-state", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_session_id: this.clientSessionId,
                    client_started_at_ms: this.clientStartedAtMs,
                    heartbeat_interval_ms: AddonStatus.EFB_STATE_HEARTBEAT_MS,
                    is_in_menu: state.isInMenu,
                    game_mode: state.gameMode,
                    game_mode_label: state.label,
                    canonical_ui_state: canonicalUiState,
                    seq,
                    source_ts_ms: sourceTsMs,
                    capture_source: state.source,
                    stability_ms: stabilityMs,
                    confirmed: true
                })
            });
            const result = await response.json().catch(() => ({} as EfbStateResponse));
            if (!response.ok || result.ok === false) {
                throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
            }
            if (result.accepted === false) {
                const reason = result.reason || "server_rejected";
                this.pendingRepostReason = reason;
                this.updatePostDebug(
                    `EFB POST: REJECTED seq=${seq} reason=${reason} `
                    + `active_session=${result.active_session_id || "-"} active_seq=${result.active_seq ?? "-"}`
                );
                return;
            }
            this.lastPostedSeq = seq;
            this.lastPostedAtMs = sourceTsMs;
            this.lastPublishedSignature = state.signature;
            const repostInfo = this.pendingRepostReason ? `; ${this.pendingRepostReason}` : "";
            this.pendingRepostReason = undefined;
            this.updatePostDebug(
                `EFB POST: OK session=${this.clientSessionId} seq=${seq} gm=${state.gameMode} `
                + `${state.label || "(empty)"} menu=${state.isInMenu} `
                + `canonical=${result.canonical_ui_state || canonicalUiState} `
                + `source=${state.source} stability=${stabilityMs}ms${repostInfo}`
            );
        } catch {
            this.pendingRepostReason = this.pendingRepostReason ?? "retry after failure";
            this.pushQueued = true;
            this.updatePostDebug("EFB POST: FAILED");
        } finally {
            this.pushInFlight = false;
            if (this.pushQueued) {
                void this.flushPushEfbState();
            }
        }
    }

    private async fetchStatus(): Promise<void> {
        try {
            const res = await fetch("http://127.0.0.1:5000/status");
            const data: StatusData = await res.json();

            if (!this.addonReachable) {
                this.addonReachable = true;
                if (this.canPostConfirmedState()) {
                    this.pendingRepostReason = "repost requested after server reconnect";
                    this.queuePushEfbState("server_reachable");
                    this.scheduleInitialPushRetry();
                } else {
                    this.updatePostDebug("EFB POST: waiting for confirmed state after server reconnect");
                }
            }

            if (this.statusText.instance) {
                this.statusText.instance.textContent = data.simconnect_connected
                    ? "SimConnect: Connected"
                    : "SimConnect: Disconnected";
                this.statusText.instance.style.color = data.simconnect_connected ? "#4CAF50" : "#f44336";
            }

            if (data.simconnect_connected && !this.simconnectWasConnected) {
                this.simconnectWasConnected = true;
                this.updateConnectionDebug("SimConnect timing: connected (waiting 2s)");
                window.setTimeout(() => {
                    this.updateConnectionDebug("SimConnect timing: 2 seconds passed");
                }, 2000);
                if (this.canPostConfirmedState()) {
                    this.pendingRepostReason = "repost requested after SimConnect reconnect";
                    this.queuePushEfbState("simconnect_connected");
                    this.scheduleInitialPushRetry();
                }
            } else if (!data.simconnect_connected) {
                this.simconnectWasConnected = false;
                this.updateConnectionDebug("SimConnect timing: disconnected");
            }

            if (this.aircraftText.instance) {
                this.aircraftText.instance.textContent = data.current_aircraft
                    ? `Aircraft: ${data.current_aircraft}`
                    : "";
            }
            this.currentAircraftTitle = typeof data.current_aircraft === "string" ? data.current_aircraft : "";
            this.setSeatCountsFromStatus(data);
            this.setPayloadStationsFromStatus(data.payload_stations);

            this.handleMissionPayloadSignal(data.mission_payload_signal ?? null);
        } catch {
            this.addonReachable = false;
            this.simconnectWasConnected = false;
            if (this.statusText.instance) {
                this.statusText.instance.textContent = "Addon server is unreachable";
                this.statusText.instance.style.color = "#f44336";
            }
        }
    }

    private buildLiveMassBalancePayload(): {
        current_aircraft: string;
        cargo_stations: Array<{
            id: number;
            name: string;
            kind: "cargo";
            mass_lbs: number;
            max_lbs: number;
            min_lbs: number;
        }>;
        baggage_stations: Array<{
            id: number;
            name: string;
            kind: "baggage";
            mass_lbs: number;
            max_lbs: number;
            min_lbs: number;
        }>;
        seat_sections: Array<{
            name: string;
            section_type: number;
            current_occupation: number;
            max_occupation: number;
            mass_per_seat_lbs: number;
            current_mass_lbs: number;
            is_passenger_loadable: boolean;
        }>;
    } {
        return {
            current_aircraft: this.currentAircraftTitle,
            cargo_stations: this.cargoStations.map(station => ({
                id: station.id,
                name: station.name,
                kind: "cargo" as const,
                mass_lbs: station.massLbs,
                max_lbs: station.maxLbs,
                min_lbs: station.minLbs,
            })),
            baggage_stations: this.baggageStations.map(station => ({
                id: station.id,
                name: station.name,
                kind: "baggage" as const,
                mass_lbs: station.massLbs,
                max_lbs: station.maxLbs,
                min_lbs: station.minLbs,
            })),
            seat_sections: this.seatStations.map(seat => ({
                name: seat.sectionName,
                section_type: seat.sectionType,
                current_occupation: seat.currentOccupation,
                max_occupation: seat.maxOccupation,
                mass_per_seat_lbs: seat.massPerSeatLbs,
                current_mass_lbs: seat.currentMassLbs,
                is_passenger_loadable: seat.isPassengerLoadable,
            })),
        };
    }

    private async pushLiveMassBalanceSnapshot(): Promise<void> {
        const payload = this.buildLiveMassBalancePayload();
        const signature = JSON.stringify(payload);
        const nowMs = Date.now();
        if (
            signature === this.lastMassBalanceStreamSignature
            && this.lastMassBalancePostedAtMs !== undefined
            && nowMs - this.lastMassBalancePostedAtMs < AddonStatus.MASS_BALANCE_HEARTBEAT_MS
        ) {
            return;
        }

        try {
            const response = await fetch("http://127.0.0.1:5000/efb-mass-balance", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: signature,
            });
            if (!response.ok) {
                return;
            }
            this.lastMassBalanceStreamSignature = signature;
            this.lastMassBalancePostedAtMs = nowMs;
        } catch {
            // Ignore stream failures; UI state should continue updating locally.
        }
    }

    private scheduleInitialPushRetry(): void {
        if (this.pendingRetryTimer !== undefined) {
            return;
        }
        this.pendingRetryTimer = window.setTimeout(() => {
            this.pendingRetryTimer = undefined;
            if (!this.canPostConfirmedState()) {
                this.updatePostDebug("EFB POST: retry skipped; waiting for confirmed state");
                return;
            }
            this.pendingRepostReason = this.pendingRepostReason ?? "scheduled retry";
            this.queuePushEfbState("scheduled_retry");
        }, 1000);
    }

    private maybeHeartbeatConfirmedState(): void {
        if (!this.confirmedState) {
            return;
        }
        if (this.pushInFlight) {
            return;
        }

        const nowMs = Date.now();
        if (
            this.lastPostedAtMs !== undefined
            && nowMs - this.lastPostedAtMs < AddonStatus.EFB_STATE_HEARTBEAT_MS
        ) {
            return;
        }

        this.pendingRepostReason = this.pendingRepostReason ?? "state heartbeat";
        this.queuePushEfbState("heartbeat", true);
    }

    private captureRawGameState(source: CaptureSource, reason: string): void {
        const snapshot = this.readGameModeSnapshot(source);
        if (!snapshot) {
            this.updatePostDebug(`EFB POST: warming up (${reason})`);
            return;
        }
        this.recordRawState(snapshot);
        this.updateGameModeDebug(
            `GameMode: ${snapshot.gameMode} ${snapshot.label || "(empty)"} | source=${snapshot.source}`
        );
        this.updateIsInMenuDebug(
            `IsInMenu: ${snapshot.isInMenu} | pending=${this.confirmedState?.signature === snapshot.signature ? "confirmed" : "pending"}`
        );
        this.scheduleConfirmation(snapshot.signature, reason);
    }

    private readGameModeSnapshot(source: CaptureSource): RawStateSample | undefined {
        const gm = this.gameModeManager;
        if (!gm) {
            return undefined;
        }
        const gameModeValue = this.readSubjectValue<number>(gm.gameMode, this.currentGameMode);
        const isInMenuValue = this.readSubjectValue<boolean>(gm.isInMenu, this.currentIsInMenu);
        if (typeof gameModeValue !== "number" || typeof isInMenuValue !== "boolean") {
            return undefined;
        }
        this.currentGameMode = gameModeValue;
        this.currentIsInMenu = isInMenuValue;
        const nowMs = Date.now();
        const signature = `${gameModeValue}|${isInMenuValue}`;
        return {
            gameMode: gameModeValue,
            isInMenu: isInMenuValue,
            label: this.mapGameModeLabel(gameModeValue),
            source,
            firstSeenAtMs: nowMs,
            lastSeenAtMs: nowMs,
            signature
        };
    }

    private readSubjectValue<T>(subject: any, fallback: T | undefined): T | undefined {
        if (subject && typeof subject.get === "function") {
            const value = subject.get();
            if (value !== undefined) {
                return value as T;
            }
        }
        if (subject && typeof subject.getValue === "function") {
            const value = subject.getValue();
            if (value !== undefined) {
                return value as T;
            }
        }
        return fallback;
    }

    private recordRawState(sample: RawStateSample): void {
        const previous = this.latestRawSample;
        if (previous && previous.signature === sample.signature) {
            this.latestRawSample = {
                ...sample,
                firstSeenAtMs: previous.firstSeenAtMs,
                lastSeenAtMs: sample.lastSeenAtMs
            };
            return;
        }
        this.latestRawSample = sample;
    }

    private scheduleConfirmation(expectedSignature: string, reason: string): void {
        if (this.confirmStateTimer !== undefined) {
            window.clearTimeout(this.confirmStateTimer);
        }
        this.confirmStateTimer = window.setTimeout(() => {
            this.confirmStateTimer = undefined;
            this.confirmStateIfStable(expectedSignature, reason);
        }, AddonStatus.STATE_CONFIRM_MS);
    }

    private confirmStateIfStable(expectedSignature: string, reason: string): void {
        const sample = this.latestRawSample;
        if (!sample || sample.signature !== expectedSignature) {
            return;
        }
        const nowMs = Date.now();
        const stabilityMs = nowMs - sample.firstSeenAtMs;
        if (stabilityMs < AddonStatus.STATE_CONFIRM_MS) {
            this.scheduleConfirmation(expectedSignature, reason);
            return;
        }
        this.confirmedState = {
            ...sample,
            lastSeenAtMs: nowMs
        };
        this.updateIsInMenuDebug(
            `IsInMenu: ${sample.isInMenu} | confirmed | stability=${stabilityMs}ms | last_seq=${this.lastPostedSeq ?? "-"}`
        );
        this.queuePushEfbState(reason);
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

    private deriveCanonicalUiState(gameMode: number, isInMenu: boolean): string {
        if (gameMode === 4 && isInMenu === false) {
            return "IN_FLIGHT";
        }
        if (gameMode === 4 && isInMenu === true) {
            return "PAUSED";
        }
        if (gameMode === 1 && isInMenu === true) {
            return "MENU_CAREER";
        }
        if (gameMode === 2 && isInMenu === true) {
            return "MENU_CHALLENGE";
        }
        if (gameMode === 3 && isInMenu === true) {
            return "MENU_DISCOVERY";
        }
        if (gameMode === 0 && isInMenu === true) {
            return "MAIN_MENU";
        }
        return "UNKNOWN";
    }

    private handleMissionPayloadSignal(signal: StatusData["mission_payload_signal"]): void {
        if (!signal || typeof signal.id !== "number") {
            return;
        }
        if (signal.id <= this.lastMissionSignalId) {
            return;
        }
        this.lastMissionSignalId = signal.id;
        this.pendingMissionSignal = signal;
        if ((signal.mode || "").toLowerCase() === "payload_zero_reset") {
            this.setResult("Payload zero reset received.", "#93c5fd");
            this.tryApplyPendingMissionSignal();
            return;
        }
        this.setResult(
            `Payload sync received: pax ${signal.target_pax_count}, cargo ${Math.round(signal.target_cargo_lbs)} lbs, baggage ${Math.round(signal.target_baggage_lbs || 0)} lbs`,
            "#93c5fd"
        );
        this.tryApplyPendingMissionSignal();
    }

    private tryApplyPendingMissionSignal(): void {
        if (!this.pendingMissionSignal) {
            return;
        }
        if (!this.massBalanceReady || !this.massBalanceListener) {
            return;
        }
        if (
            this.seatStations.length === 0
            && this.cargoStations.length === 0
            && this.baggageStations.length === 0
        ) {
            return;
        }
        const signal = this.pendingMissionSignal;
        this.pendingMissionSignal = undefined;
        this.applyMissionPayloadSignal(signal);
    }

    private async refreshMassAndBalanceData(): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        if (!this.cargoEditors.instance || !this.seatEditors.instance) {
            return;
        }

        try {
            const [cargoDecks, seatDecks, maxMassData, fuelTankData] = await Promise.all([
                this.massBalanceListener.call("GET_CARGO"),
                this.massBalanceListener.call("GET_SEATS"),
                this.massBalanceListener.call("GET_MAX_MASS_DATA"),
                this.massBalanceListener.call("GET_FUEL_TANKS")
            ]);

            const nextPayloadStations: PayloadStation[] = [];
            for (const deck of cargoDecks ?? []) {
                for (const load of deck.loads ?? []) {
                    if (typeof load.id !== "number") {
                        continue;
                    }
                    const stationName = typeof load.name === "string" ? load.name : `Station ${load.id}`;
                    nextPayloadStations.push({
                        id: load.id,
                        name: stationName,
                        kind: this.classifyPayloadStationKind(load.id, stationName),
                        massLbs: Number(load.mass_lbs_value ?? 0),
                        maxLbs: Number(load.mass_lbs_max ?? 0),
                        minLbs: Number(load.mass_lbs_min ?? 0)
                    });
                }
            }

            const nextSeats: SeatStation[] = [];
            for (const deck of seatDecks ?? []) {
                for (const section of deck.sections ?? []) {
                    const configured = Number(section.configured_occupation ?? 0);
                    const currentOccupationRaw = Number(section.occupation ?? 0);
                    const seatsArray: Array<{ is_occupied?: boolean }> = Array.isArray(section.seats) ? section.seats : [];
                    const occupiedFromSeatStates = seatsArray.reduce((count, seatItem) => count + (seatItem?.is_occupied ? 1 : 0), 0);
                    const currentMass = Number(section.current_mass ?? 0);
                    const sectionType = Number(section.type ?? 0);
                    const isCrewSection = sectionType === 0 || sectionType === 1;
                    const usedOccupation =
                        currentOccupationRaw > 0
                            ? currentOccupationRaw
                            : occupiedFromSeatStates > 0
                                ? occupiedFromSeatStates
                                : isCrewSection && currentMass > 0
                                    ? 1
                                    : currentMass > 0 && configured > 0
                                        ? configured
                                        : 0;
                    const resolvedCapacity = this.resolveSeatSectionCapacity(
                        section,
                        seatsArray,
                        currentOccupationRaw,
                        occupiedFromSeatStates,
                    );
                    const denominator = usedOccupation > 0 ? usedOccupation : configured;
                    const massPerSeat = denominator > 0 ? currentMass / denominator : 0;
                    const sectionName = typeof section.name === "string" ? section.name : "Seat Section";
                    const key = `${sectionName}::${sectionType}`;
                    const isCopilotSeat = sectionType === 1 && this.copilotSeatCount > 0;

                    nextSeats.push({
                        key,
                        sectionName,
                        sectionType,
                        currentOccupation: usedOccupation,
                        maxOccupation: resolvedCapacity,
                        massPerSeatLbs: massPerSeat,
                        currentMassLbs: currentMass,
                        isPilot: sectionType === 0,
                        isCopilot: isCopilotSeat,
                        isEditable: this.isPassengerLoadableSeat(sectionType),
                        isPassengerLoadable: this.isPassengerLoadableSeat(sectionType),
                    });
                }
            }

            const sortedPayloadStations = nextPayloadStations.sort((a, b) => a.id - b.id);
            this.cargoStations = sortedPayloadStations.filter(station => station.kind !== "baggage");
            this.baggageStations = sortedPayloadStations.filter(station => station.kind === "baggage");
            this.seatStations = nextSeats.sort((a, b) => a.sectionName.localeCompare(b.sectionName));
            void this.pushLiveMassBalanceSnapshot();
            this.updateSeatSummary();
            this.updateMassSummary(cargoDecks, seatDecks, maxMassData, fuelTankData);
            if (!this.plannerIsEditing) {
                this.renderPayloadPlanner();
            }
            this.tryApplyPendingMissionSignal();

            if (this.editingCargoIds.size === 0) {
                this.renderCargoEditors();
                this.renderBaggageEditors();
            }
            if (this.editingSeatKeys.size === 0) {
                this.renderSeatEditors();
            }
        } catch {
            if (this.cargoResult.instance) {
                this.cargoResult.instance.textContent = "Mass & Balance data could not be read.";
                this.cargoResult.instance.style.color = "#f44336";
            }
        }
    }

    private updateMassSummary(cargoDecks: any[], seatDecks: any[], maxMassData: any, fuelTankData: any): void {
        const cargoMass = (cargoDecks ?? []).reduce((sumDeck: number, deck: any) => {
            const deckMass = (deck?.loads ?? []).reduce((sumLoad: number, load: any) => {
                return sumLoad + Number(load?.mass_lbs_value ?? 0);
            }, 0);
            return sumDeck + deckMass;
        }, 0);

        const seatsMass = (seatDecks ?? []).reduce((sumDeck: number, deck: any) => {
            const deckMass = (deck?.sections ?? []).reduce((sumSection: number, section: any) => {
                const sectionType = Number(section?.type ?? 0);
                if (sectionType === 0 || sectionType === 1) {
                    return sumSection;
                }
                return sumSection + Number(section?.current_mass ?? 0);
            }, 0);
            return sumDeck + deckMass;
        }, 0);

        this.currentPayloadLbs = cargoMass + seatsMass;
        this.currentTowLbs = Number(SimVar.GetSimVarValue("A:TOTAL WEIGHT", "pounds") ?? 0);
        this.maxTowLbs = Number(maxMassData?.max_takeoff_lbs ?? 0);
        this.emptyWeightLbs = Number(maxMassData?.empty_mass ?? SimVar.GetSimVarValue("A:EMPTY WEIGHT", "pounds") ?? 0);
        this.maxZfwLbs = Number(maxMassData?.max_zfw_lbs ?? 0);
        this.currentFuelLbs = (fuelTankData?.tanks ?? []).reduce((sum: number, tank: any) => {
            const ratio = Number(tank?.value_percent ?? 0);
            const maxMass = Number(tank?.mass_lbs_max ?? 0);
            return sum + ratio * maxMass;
        }, 0);
        this.totalFuelCapacityGallons = (fuelTankData?.tanks ?? []).reduce((sum: number, tank: any) => {
            return sum + Number(tank?.volume_gal_max ?? 0);
        }, 0);
        const detectedPassengerCapacity = this.seatStations
            .filter(s => s.isPassengerLoadable)
            .reduce((sum, s) => sum + s.maxOccupation, 0);
        this.maxPaxCapacity =
            this.passengerSeatCount > 0
                ? Math.min(detectedPassengerCapacity, this.passengerSeatCount)
                : detectedPassengerCapacity;
        this.maxCargoCapacityLbs = this.cargoStations.reduce((sum, s) => sum + s.maxLbs, 0);

        const maxPayloadByZfw = this.maxZfwLbs > 0 ? Math.max(0, this.maxZfwLbs - this.emptyWeightLbs) : Number.POSITIVE_INFINITY;
        const maxPayloadByTow = this.maxTowLbs > 0 ? Math.max(0, this.maxTowLbs - this.emptyWeightLbs - this.currentFuelLbs) : Number.POSITIVE_INFINITY;
        this.safePayloadMaxLbs = Math.max(0, Math.min(maxPayloadByZfw, maxPayloadByTow));

        if (this.massSummary.instance) {
            const towPct = this.maxTowLbs > 0 ? (this.currentTowLbs / this.maxTowLbs) * 100 : 0;
            const maxPayloadByZfwText = Number.isFinite(maxPayloadByZfw) ? maxPayloadByZfw.toFixed(1) : "N/A";
            this.massSummary.instance.textContent =
                `Total Payload: ${this.currentPayloadLbs.toFixed(1)} lbs | ` +
                `TOW: ${this.currentTowLbs.toFixed(1)} lbs` +
                (this.maxTowLbs > 0 ? ` / Max TOW: ${this.maxTowLbs.toFixed(1)} lbs (${towPct.toFixed(1)}%)` : "") +
                ` | Est. Payload Cap (ZFW): ${maxPayloadByZfwText} lbs` +
                ` | Safe Payload for TO: ${this.safePayloadMaxLbs.toFixed(1)} lbs`;
        }
    }

    private getAverageSeatMassLbs(): number {
        const eligible = this.seatStations.filter(s => s.isPassengerLoadable && s.maxOccupation > 0);
        if (eligible.length === 0) {
            return AddonStatus.DEFAULT_PAX_WEIGHT_LBS;
        }
        const totalCapacity = eligible.reduce((sum, s) => sum + s.maxOccupation, 0);
        const weightedMass = eligible.reduce((sum, s) => sum + (s.massPerSeatLbs > 0 ? s.massPerSeatLbs : AddonStatus.DEFAULT_PAX_WEIGHT_LBS) * s.maxOccupation, 0);
        return totalCapacity > 0 ? weightedMass / totalCapacity : AddonStatus.DEFAULT_PAX_WEIGHT_LBS;
    }

    private computePayloadPlan(targetPayloadLbs: number): { paxCount: number; seatMass: number; cargoMass: number; actualPayload: number; estimatedTow: number } {
        const avgSeatMass = AddonStatus.DEFAULT_PAX_WEIGHT_LBS;
        const paxCount = Math.max(0, Math.min(this.maxPaxCapacity, Math.floor(targetPayloadLbs / avgSeatMass)));
        const seatMass = paxCount * avgSeatMass;
        const cargoMass = Math.max(0, Math.min(this.maxCargoCapacityLbs, targetPayloadLbs - seatMass));
        const actualPayload = seatMass + cargoMass;
        const estimatedTow = this.emptyWeightLbs + this.currentFuelLbs + actualPayload;
        return { paxCount, seatMass, cargoMass, actualPayload, estimatedTow };
    }

    private classifyPayloadStationKind(stationId: number, name: string): PayloadStationKind {
        const knownKind = this.payloadStationsById.get(stationId) ?? this.payloadStationsById.get(stationId - 1);
        if (knownKind) {
            return knownKind;
        }
        const normalized = name.trim().toLowerCase();
        if (!normalized) {
            return "unknown";
        }
        if (normalized.includes("baggage")) {
            return "baggage";
        }
        if (normalized.includes("cargo") || normalized.includes("tail") || normalized.includes("hold")) {
            return "cargo";
        }
        return "cargo";
    }

    private renderPayloadPlanner(): void {
        if (!this.payloadPlanner.instance) {
            return;
        }

        this.payloadPlanner.instance.innerHTML = "";
        if (this.safePayloadMaxLbs <= 0 || (this.maxPaxCapacity <= 0 && this.maxCargoCapacityLbs <= 0)) {
            this.payloadPlanner.instance.innerHTML = "<div style='color:#aaa'>Payload planner data is not ready.</div>";
            return;
        }

        const container = document.createElement("div");
        container.style.background = "linear-gradient(180deg, #1f2937, #111827)";
        container.style.border = "1px solid #334155";
        container.style.borderRadius = "12px";
        container.style.padding = "12px";
        container.style.display = "grid";
        container.style.gridTemplateColumns = "1fr 120px 140px";
        container.style.gap = "8px";
        container.style.alignItems = "center";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.value = this.plannerPercent.toString();
        slider.style.height = "30px";
        slider.style.accentColor = "#22c55e";
        slider.style.transform = "scaleY(1.8)";
        slider.style.transformOrigin = "center";
        slider.style.cursor = "pointer";
        slider.style.margin = "6px 0";

        const pctInput = document.createElement("input");
        pctInput.type = "number";
        pctInput.min = "0";
        pctInput.max = "100";
        pctInput.step = "1";
        pctInput.value = this.plannerPercent.toString();
        pctInput.style.height = "36px";
        pctInput.style.padding = "6px 8px";
        pctInput.style.background = "#0b1220";
        pctInput.style.color = "#fff";
        pctInput.style.border = "1px solid #475569";
        pctInput.style.borderRadius = "8px";
        pctInput.style.fontSize = "14px";
        pctInput.style.fontWeight = "600";

        const applyBtn = this.createActionButton(
            "Apply TO-safe",
            (): void => { this.applyTakeoffSafePayload(Number(slider.value)); },
            "green",
        );
        applyBtn.style.minWidth = "140px";

        const detail = document.createElement("div");
        detail.style.gridColumn = "1 / span 3";
        detail.style.fontSize = "13px";
        detail.style.color = "#cfe7d0";
        detail.style.marginTop = "6px";
        detail.style.lineHeight = "1.5";

        const syncAndPreview = (pctRaw: number): void => {
            const pct = Math.max(0, Math.min(100, Math.round(pctRaw)));
            this.plannerPercent = pct;
            slider.value = pct.toString();
            pctInput.value = pct.toString();

            const targetPayload = this.safePayloadMaxLbs * (pct / 100);
            const plan = this.computePayloadPlan(targetPayload);
            detail.textContent =
                `Planner ${pct}% -> target payload ${targetPayload.toFixed(0)} lbs | ` +
                `pax ${plan.paxCount} | cargo ${plan.cargoMass.toFixed(0)} lbs | ` +
                `est TOW ${plan.estimatedTow.toFixed(0)} / ${this.maxTowLbs.toFixed(0)} lbs`;
        };

        slider.onfocus = (): void => { this.plannerIsEditing = true; };
        slider.onblur = (): void => { this.plannerIsEditing = false; };
        pctInput.onfocus = (): void => { this.plannerIsEditing = true; };
        pctInput.onblur = (): void => { this.plannerIsEditing = false; };
        slider.oninput = (): void => syncAndPreview(Number(slider.value));
        pctInput.oninput = (): void => syncAndPreview(Number(pctInput.value));
        syncAndPreview(this.plannerPercent);
        container.appendChild(slider);
        container.appendChild(pctInput);
        container.appendChild(applyBtn);
        container.appendChild(detail);
        this.payloadPlanner.instance.appendChild(container);
    }

    private buildSeatSettersForPax(targetPax: number, avgMassLbs = AddonStatus.DEFAULT_PAX_WEIGHT_LBS): Array<Record<string, unknown>> {
        const editableSeats = this.seatStations
            .filter(seat => seat.sectionType === 2)
            .sort((a, b) => a.sectionType - b.sectionType || a.sectionName.localeCompare(b.sectionName));
        const setters: Array<Record<string, unknown>> = [];
        let remaining = targetPax;
        for (const seat of editableSeats) {
            const assigned = Math.max(0, Math.min(seat.maxOccupation, remaining));
            remaining -= assigned;
            setters.push({
                __Type: "SeatSetter",
                section_name: seat.sectionName,
                section_type: seat.sectionType,
                occupation: assigned,
                mass_per_seat_lbs: avgMassLbs
            });
        }
        return setters;
    }

    private buildCargoSettersForMass(targetCargoLbs: number): Array<Record<string, unknown>> {
        const sorted = [...this.cargoStations].sort((a, b) => a.maxLbs - b.maxLbs);
        const setters: Array<Record<string, unknown>> = [];
        let remaining = Math.max(0, targetCargoLbs);
        let remainingItems = sorted.length;

        for (const station of sorted) {
            let ideal = remainingItems > 0 ? Math.round(remaining / remainingItems) : 0;
            let assigned = Math.max(station.minLbs, Math.min(station.maxLbs, ideal));
            assigned = Math.min(assigned, remaining);
            remaining -= assigned;
            remainingItems -= 1;
            setters.push({
                __Type: "CargoSetter",
                id: station.id,
                mass_lbs: assigned
            });
        }

        return setters;
    }

    private buildBaggageSettersForMass(targetBaggageLbs: number): Array<Record<string, unknown>> {
        const sorted = [...this.baggageStations].sort((a, b) => a.maxLbs - b.maxLbs);
        const setters: Array<Record<string, unknown>> = [];
        let remaining = Math.max(0, targetBaggageLbs);
        let remainingItems = sorted.length;

        for (const station of sorted) {
            let ideal = remainingItems > 0 ? Math.round(remaining / remainingItems) : 0;
            let assigned = Math.max(station.minLbs, Math.min(station.maxLbs, ideal));
            assigned = Math.min(assigned, remaining);
            remaining -= assigned;
            remainingItems -= 1;
            setters.push({
                __Type: "CargoSetter",
                id: station.id,
                mass_lbs: assigned
            });
        }

        return setters;
    }

    private describePayloadSyncReason(reason?: string): string {
        switch ((reason || "").toLowerCase()) {
            case "send_atc":
                return "Payload sync sent";
            case "deliver_mission":
                return "Mission payload removed";
            case "abandon_mission":
                return "Mission payload removed";
            default:
                return "Aircraft payload synced";
        }
    }

    private async applySeatsImmediate(setters: Array<Record<string, unknown>>): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        if (setters.length === 0) {
            return;
        }
        await this.massBalanceListener.call("SET_SEATS", setters, true);
    }

    private async applySeatsStaged(setters: Array<Record<string, unknown>>): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        if (setters.length === 0) {
            return;
        }
        await this.massBalanceListener.call("SET_SEATS", setters, false);
    }

    private buildSeatZeroSettersForReset(): Array<Record<string, unknown>> {
        return this.seatStations
            .filter(seat => seat.sectionType === 2)
            .map(seat => ({
                __Type: "SeatSetter",
                section_name: seat.sectionName,
                section_type: seat.sectionType,
                occupation: 0,
                mass_per_seat_lbs: seat.massPerSeatLbs > 0 ? seat.massPerSeatLbs : AddonStatus.DEFAULT_PAX_WEIGHT_LBS
            }));
    }

    private buildPayloadZeroSetters(): Array<Record<string, unknown>> {
        return [...this.cargoStations, ...this.baggageStations].map(station => ({
            __Type: "CargoSetter",
            id: station.id,
            mass_lbs: 0
        }));
    }

    private async applyPayloadZeroResetSignal(): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }

        const seatSetters = this.buildSeatZeroSettersForReset();
        const payloadSetters = this.buildPayloadZeroSetters();

        try {
            await Promise.all([
                this.applySeatsImmediate(seatSetters),
                this.massBalanceListener.call("SET_CARGO", payloadSetters)
            ]);
            await this.refreshMassAndBalanceData();
            this.setResult(
                "Sim payload reset requested. Passenger seats and cargo/baggage stations set to zero.",
                "#4CAF50"
            );
        } catch {
            this.setResult("Payload zero reset failed.", "#f44336");
        }
    }

    private async applyTakeoffSafePayload(percent: number): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }

        const pct = Math.max(0, Math.min(100, Math.round(percent)));
        const targetPayload = this.safePayloadMaxLbs * (pct / 100);
        const plan = this.computePayloadPlan(targetPayload);
        const seatSetters = this.buildSeatSettersForPax(plan.paxCount);
        const cargoSetters = this.buildCargoSettersForMass(plan.cargoMass);

        this.setResult("Applying takeoff-safe payload plan...", "#FFA726");
        try {
            await Promise.all([
                this.applySeatsImmediate(seatSetters),
                this.massBalanceListener.call("SET_CARGO", cargoSetters)
            ]);
            await this.refreshMassAndBalanceData();
            this.setResult(
                `Applied ${pct}% plan -> pax ${plan.paxCount}, cargo ${plan.cargoMass.toFixed(0)} lbs, est TOW ${plan.estimatedTow.toFixed(0)} lbs.`,
                "#4CAF50"
            );
        } catch {
            this.setResult("Takeoff-safe payload apply failed.", "#f44336");
        }
    }

    private async applyMissionPayloadSignal(signal: NonNullable<StatusData["mission_payload_signal"]>): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        const mode = (signal.mode || "sync_aircraft_payload").toLowerCase();
        if (mode === "payload_zero_reset") {
            await this.applyPayloadZeroResetSignal();
            return;
        }
        const paxTarget = Math.max(0, Math.min(this.maxPaxCapacity, Math.round(signal.target_pax_count || 0)));
        const cargoTarget = Math.max(0, Math.min(this.maxCargoCapacityLbs, Number(signal.target_cargo_lbs || 0)));
        const maxBaggageCapacityLbs = this.baggageStations.reduce((sum, station) => sum + station.maxLbs, 0);
        const baggageTarget = Math.max(0, Math.min(maxBaggageCapacityLbs, Number(signal.target_baggage_lbs || 0)));
        const avgMass = Math.max(1, Number(signal.avg_pax_lbs || AddonStatus.DEFAULT_PAX_WEIGHT_LBS));

        if (baggageTarget > 0 && this.baggageStations.length === 0) {
            this.setResult("Payload sync failed: no baggage stations available for this aircraft.", "#f44336");
            return;
        }

        const seatSetters = this.buildSeatSettersForPax(paxTarget, avgMass);
        const cargoSetters = this.buildCargoSettersForMass(cargoTarget);
        const baggageSetters = this.buildBaggageSettersForMass(baggageTarget);

        try {
            await Promise.all([
                this.applySeatsImmediate(seatSetters),
                this.massBalanceListener.call("SET_CARGO", [...cargoSetters, ...baggageSetters])
            ]);

            if (signal.open_atc) {
                LaunchFlowEventToGlobalFlow("OPEN_ATC_PANEL");
            }

            const statusText =
                `${this.describePayloadSyncReason(signal.reason)}: ` +
                `pax ${paxTarget}, cargo ${Math.round(cargoTarget)} lbs, baggage ${Math.round(baggageTarget)} lbs` +
                `${signal.open_atc ? " | ATC panel opened" : ""}.`;
            this.setResult(statusText, "#4CAF50");
            await this.refreshMassAndBalanceData();
        } catch {
            this.setResult("Payload sync failed.", "#f44336");
        }
    }

    private updateSeatSummary(): void {
        if (!this.seatSummary.instance) {
            return;
        }
        const passengerSeats = this.seatStations.filter(seat => seat.sectionType === 2);
        const detectedPassengerSeats = passengerSeats.reduce((sum, s) => sum + s.maxOccupation, 0);
        const totalPassengerSeats =
            this.passengerSeatCount > 0
                ? Math.min(detectedPassengerSeats, this.passengerSeatCount)
                : detectedPassengerSeats;
        const totalOccupiedPassengerSeats = passengerSeats.reduce((sum, s) => sum + s.currentOccupation, 0);
        this.seatSummary.instance.textContent =
            `Passenger-loadable seats: ${totalPassengerSeats} | Occupied pax: ${totalOccupiedPassengerSeats}`;
    }

    private renderCargoEditors(): void {
        if (!this.cargoEditors.instance) {
            return;
        }

        this.cargoEditors.instance.innerHTML = "";

        if (this.cargoStations.length === 0) {
            this.cargoEditors.instance.innerHTML = "<div style='color:#aaa'>No cargo station found for this aircraft.</div>";
            return;
        }

        for (const station of this.cargoStations) {
            const row = document.createElement("div");
            row.style.background = "linear-gradient(180deg, #111827, #0b1220)";
            row.style.border = "1px solid #334155";
            row.style.borderRadius = "10px";
            row.style.padding = "10px";
            row.style.display = "grid";
            row.style.gridTemplateColumns = "1fr 120px 70px";
            row.style.gap = "8px";
            row.style.alignItems = "center";
            row.style.marginBottom = "8px";

            const info = document.createElement("div");
            info.style.color = "#ddd";
            info.style.fontSize = "14px";
            info.style.lineHeight = "1.4";
            info.textContent =
                `Cargo ${station.id} (${station.name})  Current: ${station.massLbs.toFixed(1)} lbs  Max: ${station.maxLbs.toFixed(1)} lbs`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = station.minLbs.toString();
            input.max = station.maxLbs.toString();
            input.value = this.cargoDraftValues.get(station.id) ?? station.massLbs.toFixed(0);
            input.style.width = "100%";
            input.style.height = "36px";
            input.style.padding = "6px 8px";
            input.style.background = "#020617";
            input.style.color = "#fff";
            input.style.border = "1px solid #475569";
            input.style.borderRadius = "8px";
            input.style.fontSize = "14px";
            input.style.fontWeight = "600";
            input.onfocus = (): void => { this.editingCargoIds.add(station.id); };
            input.onblur = (): void => {
                this.editingCargoIds.delete(station.id);
                this.cargoDraftValues.set(station.id, input.value);
            };
            input.oninput = (): void => { this.cargoDraftValues.set(station.id, input.value); };

            const button = this.createActionButton(
                "Set",
                (): void => { this.setSingleCargoStation(station, input.value); },
                "blue",
            );

            row.appendChild(info);
            row.appendChild(input);
            row.appendChild(button);
            this.cargoEditors.instance.appendChild(row);
        }
    }

    private renderBaggageEditors(): void {
        if (!this.baggageEditors.instance) {
            return;
        }

        this.baggageEditors.instance.innerHTML = "";

        if (this.baggageStations.length === 0) {
            this.baggageEditors.instance.innerHTML = "<div style='color:#aaa'>No baggage station found for this aircraft.</div>";
            return;
        }

        for (const station of this.baggageStations) {
            const row = document.createElement("div");
            row.style.background = "linear-gradient(180deg, #111827, #0b1220)";
            row.style.border = "1px solid #334155";
            row.style.borderRadius = "10px";
            row.style.padding = "10px";
            row.style.display = "grid";
            row.style.gridTemplateColumns = "1fr 120px 70px";
            row.style.gap = "8px";
            row.style.alignItems = "center";
            row.style.marginBottom = "8px";

            const info = document.createElement("div");
            info.style.color = "#ddd";
            info.style.fontSize = "14px";
            info.style.lineHeight = "1.4";
            info.textContent =
                `Baggage ${station.id} (${station.name})  Current: ${station.massLbs.toFixed(1)} lbs  Max: ${station.maxLbs.toFixed(1)} lbs`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = station.minLbs.toString();
            input.max = station.maxLbs.toString();
            input.value = this.cargoDraftValues.get(station.id) ?? station.massLbs.toFixed(0);
            input.style.width = "100%";
            input.style.height = "36px";
            input.style.padding = "6px 8px";
            input.style.background = "#020617";
            input.style.color = "#fff";
            input.style.border = "1px solid #475569";
            input.style.borderRadius = "8px";
            input.style.fontSize = "14px";
            input.style.fontWeight = "600";
            input.onfocus = (): void => { this.editingCargoIds.add(station.id); };
            input.onblur = (): void => {
                this.editingCargoIds.delete(station.id);
                this.cargoDraftValues.set(station.id, input.value);
            };
            input.oninput = (): void => { this.cargoDraftValues.set(station.id, input.value); };

            const button = this.createActionButton(
                "Set",
                (): void => { this.setSingleCargoStation(station, input.value); },
                "teal",
            );

            row.appendChild(info);
            row.appendChild(input);
            row.appendChild(button);
            this.baggageEditors.instance.appendChild(row);
        }
    }

    private renderSeatEditors(): void {
        if (!this.seatEditors.instance) {
            return;
        }

        this.seatEditors.instance.innerHTML = "";

        const editableSeats = this.seatStations.filter(seat => seat.sectionType === 2);
        if (editableSeats.length === 0) {
            this.seatEditors.instance.innerHTML = "<div style='color:#aaa'>No passenger seat section found for this aircraft.</div>";
            return;
        }

        for (const seat of editableSeats) {
            const row = document.createElement("div");
            row.style.background = "linear-gradient(180deg, #111827, #0b1220)";
            row.style.border = "1px solid #334155";
            row.style.borderRadius = "10px";
            row.style.padding = "10px";
            row.style.display = "grid";
            row.style.gridTemplateColumns = "1fr 120px 70px";
            row.style.gap = "8px";
            row.style.alignItems = "center";
            row.style.marginBottom = "8px";

            const info = document.createElement("div");
            info.style.color = "#ddd";
            info.style.fontSize = "14px";
            info.style.lineHeight = "1.4";
            const seatRole = "Passenger seat";
            info.textContent =
                `${seat.sectionName} (${seatRole})  Current Pax: ${seat.currentOccupation}  Max Pax: ${seat.maxOccupation}`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = "0";
            input.max = seat.maxOccupation.toString();
            input.value = this.seatDraftValues.get(seat.key) ?? seat.currentOccupation.toString();
            input.style.width = "100%";
            input.style.height = "36px";
            input.style.padding = "6px 8px";
            input.style.background = "#020617";
            input.style.color = "#fff";
            input.style.border = "1px solid #475569";
            input.style.borderRadius = "8px";
            input.style.fontSize = "14px";
            input.style.fontWeight = "600";
            input.onfocus = (): void => { this.editingSeatKeys.add(seat.key); };
            input.onblur = (): void => {
                this.editingSeatKeys.delete(seat.key);
                this.seatDraftValues.set(seat.key, input.value);
            };
            input.oninput = (): void => { this.seatDraftValues.set(seat.key, input.value); };

            const button = this.createActionButton(
                "Set",
                (): void => { this.setSingleSeatStation(seat, input.value); },
                "blue",
            );

            row.appendChild(info);
            row.appendChild(input);
            row.appendChild(button);
            this.seatEditors.instance.appendChild(row);
        }
    }

    private async setSingleCargoStation(station: PayloadStation, rawValue: string): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }

        const value = Number(rawValue);
        if (Number.isNaN(value)) {
            this.setResult(`Cargo ${station.id}: invalid value`, "#f44336");
            return;
        }

        const clamped = Math.max(station.minLbs, Math.min(station.maxLbs, value));
        try {
            await this.massBalanceListener.call("SET_CARGO", [{
                __Type: "CargoSetter",
                id: station.id,
                mass_lbs: clamped
            }]);
            await SimVar.SetSimVarValue(`A:PAYLOAD STATION WEIGHT:${station.id}`, "pounds", clamped);
            this.cargoDraftValues.delete(station.id);
            await this.refreshMassAndBalanceData();
            this.setResult(
                `Cargo ${station.id} set to ${clamped.toFixed(1)} lbs${clamped !== value ? " (clamped)" : ""}`,
                "#4CAF50"
            );
        } catch {
            this.setResult(`Cargo ${station.id} update failed`, "#f44336");
        }
    }

    private async setSingleSeatStation(seat: SeatStation, rawValue: string): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        if (seat.sectionType !== 2) {
            this.setResult(`${seat.sectionName}: only passenger sections can be edited as payload`, "#f44336");
            return;
        }

        const value = Math.round(Number(rawValue));
        if (Number.isNaN(value)) {
            this.setResult(`${seat.sectionName}: invalid value`, "#f44336");
            return;
        }

        const clampedOcc = Math.max(0, Math.min(seat.maxOccupation, value));
        const massPerSeat = seat.massPerSeatLbs > 0 ? seat.massPerSeatLbs : AddonStatus.DEFAULT_PAX_WEIGHT_LBS;

        try {
            await this.applySeatsImmediate([{
                __Type: "SeatSetter",
                section_name: seat.sectionName,
                section_type: seat.sectionType,
                occupation: clampedOcc,
                mass_per_seat_lbs: massPerSeat
            }]);
            this.seatDraftValues.delete(seat.key);
            await this.refreshMassAndBalanceData();
            this.setResult(
                `${seat.sectionName} set to ${clampedOcc} pax${clampedOcc !== value ? " (clamped)" : ""}`,
                "#4CAF50"
            );
        } catch {
            this.setResult(`${seat.sectionName} update failed`, "#f44336");
        }
    }

    private setResult(text: string, color: string): void {
        if (!this.cargoResult.instance) {
            return;
        }
        this.cargoResult.instance.textContent = text;
        this.cargoResult.instance.style.color = color;
    }

    private async loadCargoPreset(): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }

        this.setResult("Applying cargo preset...", "#FFA726");
        try {
            if (this.cargoStations.length === 0) {
                await this.refreshMassAndBalanceData();
            }

            const targetMasses = [300, 300, 300, 120, 50];
            const setters = this.cargoStations.map((station, index) => ({
                __Type: "CargoSetter",
                id: station.id,
                mass_lbs: Math.max(station.minLbs, Math.min(station.maxLbs, targetMasses[index] ?? 0))
            }));

            await this.massBalanceListener.call("SET_CARGO", setters);
            await this.refreshMassAndBalanceData();
            this.setResult("Preset applied (MassAndBalance listener).", "#4CAF50");
        } catch {
            this.setResult("Preset could not be applied.", "#f44336");
        }
    }

    private async sendPlannerConfigToAtcAndOpen(): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            return;
        }
        try {
            const targetPayload = this.safePayloadMaxLbs * (this.plannerPercent / 100);
            const plan = this.computePayloadPlan(targetPayload);
            const seatSetters = this.buildSeatSettersForPax(plan.paxCount);
            const cargoSetters = this.buildCargoSettersForMass(plan.cargoMass);

            await Promise.all([
                // `false` matches aircraft app "Save config and open ATC panel" path (non-immediate seat load).
                this.applySeatsStaged(seatSetters),
                this.massBalanceListener.call("SET_CARGO", cargoSetters)
            ]);
            LaunchFlowEventToGlobalFlow("OPEN_ATC_PANEL");
            this.setResult(
                `Planner ${this.plannerPercent}% saved for ATC request. ATC panel opened.`,
                "#4CAF50"
            );
        } catch {
            this.setResult("Could not send planner config to ATC flow.", "#f44336");
        }
    }

    private normalizeText(value: unknown): string {
        return typeof value === "string" ? value.trim() : "";
    }

    private getAircraftInfoDetails(): AircraftInfoDetail[] {
        return Array.isArray(this.selectedPlaneSnapshot?.details) ? this.selectedPlaneSnapshot.details : [];
    }

    private parseNumericDetailValue(detail?: AircraftInfoDetail): number | null {
        if (!detail) {
            return null;
        }
        if (typeof detail.value === "number" && Number.isFinite(detail.value)) {
            return detail.value;
        }
        const text = this.normalizeText(detail.valueStr).replace(/,/g, "");
        if (!text) {
            return null;
        }
        const match = text.match(/-?\d+(\.\d+)?/);
        if (!match) {
            return null;
        }
        const parsed = Number(match[0]);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private findAircraftDetail(predicate: (detail: AircraftInfoDetail, normalizedName: string, normalizedUnit: string) => boolean): AircraftInfoDetail | undefined {
        return this.getAircraftInfoDetails().find(detail => {
            const normalizedName = this.normalizeText(detail.name).toUpperCase();
            const normalizedUnit = this.normalizeText(detail.unit).toUpperCase();
            return predicate(detail, normalizedName, normalizedUnit);
        });
    }

    private convertToKnots(value: number, unit: string): number {
        const normalizedUnit = unit.toUpperCase();
        if (normalizedUnit.includes("KPH") || normalizedUnit.includes("KILOMETER")) {
            return value * 0.5399568;
        }
        return value;
    }

    private convertToFeet(value: number, unit: string): number {
        const normalizedUnit = unit.toUpperCase();
        if (normalizedUnit.includes("METER")) {
            return value * 3.280839895;
        }
        return value;
    }

    private convertToNm(value: number, unit: string): number {
        const normalizedUnit = unit.toUpperCase();
        if (normalizedUnit.includes("KILOMETER")) {
            return value * 0.5399568;
        }
        return value;
    }

    private extractFuelUsageGph(): number | null {
        const detail = this.findAircraftDetail((entry, name, unit) =>
            (name.includes("FUEL") && (name.includes("BURN") || name.includes("CONSUMPTION") || name.includes("USAGE")))
            || unit.includes("GAL/HR")
            || unit.includes("GPH")
        );
        const value = this.parseNumericDetailValue(detail);
        if (value === null) {
            return null;
        }
        const unit = this.normalizeText(detail?.unit).toUpperCase();
        if (unit.includes("LITER")) {
            return value * 0.264172052;
        }
        return value;
    }

    private parseRawFlightPerformanceData(rawData: unknown): Record<string, unknown> | null {
        if (rawData && typeof rawData === "object") {
            return rawData as Record<string, unknown>;
        }
        if (typeof rawData !== "string") {
            return null;
        }
        try {
            const parsed = JSON.parse(rawData) as unknown;
            return parsed && typeof parsed === "object"
                ? parsed as Record<string, unknown>
                : null;
        } catch {
            return null;
        }
    }

    private parsePerformanceTable(
        dimensionCount: number,
        rawTable: unknown,
    ): { inputs: number[][]; outputs: number[] } | null {
        if (!Number.isInteger(dimensionCount) || dimensionCount <= 0) {
            return null;
        }
        if (typeof rawTable !== "string") {
            return null;
        }
        const segments = rawTable.split("::");
        if (segments.length !== 2) {
            return null;
        }
        const [rawInputs, rawOutputs] = segments;
        const inputDims = rawInputs.split(":");
        if (inputDims.length !== dimensionCount) {
            return null;
        }
        const inputs: number[][] = [];
        for (const inputDim of inputDims) {
            const parsed = inputDim.split(",").map(token => Number(token));
            if (parsed.length === 0 || parsed.some(value => !Number.isFinite(value))) {
                return null;
            }
            inputs.push(parsed);
        }

        const outputBlocks = rawOutputs.split(":");
        const expectedBlocks = inputs.reduce((product, breakpoints, index, array) => (
            index === array.length - 1 ? product : product * breakpoints.length
        ), 1);
        if (outputBlocks.length !== expectedBlocks) {
            return null;
        }
        const innerLength = inputs[inputs.length - 1].length;
        const outputs: number[] = [];
        for (const block of outputBlocks) {
            const parsed = block.split(",").map(token => Number(token));
            if (parsed.length !== innerLength || parsed.some(value => !Number.isFinite(value))) {
                return null;
            }
            outputs.push(...parsed);
        }
        return outputs.length > 0 ? { inputs, outputs } : null;
    }

    private parseFuelDensityArray(rawPerformanceData: Record<string, unknown>): number[] {
        const enginePerformance = rawPerformanceData.ENGINE_PERFORMANCE;
        if (!enginePerformance || typeof enginePerformance !== "object") {
            return [];
        }
        const fuelDensityTable = (enginePerformance as Record<string, unknown>).fuel_density_table;
        if (typeof fuelDensityTable !== "string") {
            return [];
        }
        return fuelDensityTable
            .split(",")
            .map(token => Number(token.trim()))
            .filter(value => Number.isFinite(value) && value > 0);
    }

    private resolveProfileFuelDensity(
        profile: Record<string, unknown>,
        fuelDensityArray: number[],
    ): number {
        const fuelTypeIndex = profile.fuel_type_idx;
        if (typeof fuelTypeIndex === "number" && Number.isInteger(fuelTypeIndex)) {
            const indexedDensity = fuelDensityArray[fuelTypeIndex];
            if (Number.isFinite(indexedDensity) && indexedDensity > 0) {
                return indexedDensity;
            }
        }
        if (fuelDensityArray.length > 0) {
            return fuelDensityArray[0];
        }
        return 6.7;
    }

    private estimateCruiseFuelUsageFromRawPerformance(
        rawPerformanceData: Record<string, unknown>,
    ): { fuelUsageGph: number | null; fuelDensity: number | null } {
        const atlasFormat = rawPerformanceData.ATLAS_FORMAT === true;
        const fuelDensityArray = this.parseFuelDensityArray(rawPerformanceData);
        const defaultDensity = fuelDensityArray.length > 0 ? fuelDensityArray[0] : 6.7;
        const cruiseProfileKeys = Object.keys(rawPerformanceData)
            .map(key => {
                const match = key.match(/^CRUISE_PERFORMANCE\.(\d+)$/);
                return match ? { key, index: Number(match[1]) } : null;
            })
            .filter((entry): entry is { key: string; index: number } => entry !== null)
            .sort((left, right) => left.index - right.index);

        for (const { key } of cruiseProfileKeys) {
            const profileCandidate = rawPerformanceData[key];
            if (!profileCandidate || typeof profileCandidate !== "object") {
                continue;
            }
            const profile = profileCandidate as Record<string, unknown>;
            const profileName = this.normalizeText(profile.profile_name).toUpperCase();
            if (profileName.startsWith("[HOLDING]")) {
                continue;
            }

            const fuelDensity = this.resolveProfileFuelDensity(profile, fuelDensityArray);
            const parsedTable = this.parsePerformanceTable(
                3,
                profile.cruise_fuel_consumption_table_by_weight_and_ISA_dev_and_altitude,
            );
            if (!parsedTable) {
                continue;
            }

            const positiveOutputs = parsedTable.outputs
                .filter(value => Number.isFinite(value) && value > 0)
                .sort((left, right) => left - right);
            if (positiveOutputs.length === 0) {
                continue;
            }
            const representative = positiveOutputs[Math.floor(positiveOutputs.length / 2)];
            if (!Number.isFinite(representative) || representative <= 0) {
                continue;
            }

            return {
                fuelUsageGph: atlasFormat ? representative / fuelDensity : representative,
                fuelDensity,
            };
        }

        return { fuelUsageGph: null, fuelDensity: defaultDensity };
    }

    private async refreshFlightPerformanceData(): Promise<void> {
        this.cachedFuelUsageGph = null;
        this.cachedFuelDensityLbsPerGallon = null;
        if (!this.flightPerformanceListener || !this.flightPerformanceReady) {
            return;
        }
        try {
            const rawData = await this.flightPerformanceListener.call("GET_RAW_FLIGHT_PERFORMANCE_DATA");
            const parsed = this.parseRawFlightPerformanceData(rawData);
            if (!parsed) {
                return;
            }
            const fuelMetrics = this.estimateCruiseFuelUsageFromRawPerformance(parsed);
            this.cachedFuelUsageGph = fuelMetrics.fuelUsageGph;
            this.cachedFuelDensityLbsPerGallon = fuelMetrics.fuelDensity;
        } catch {
            // Ignore listener errors; JSON export should continue with fallback data.
        }
    }

    private resolveFuelUsageAndDensity(): { fuelUsageGph: number | null; fuelDensity: number | null } {
        const detailFuelUsageGph = this.extractFuelUsageGph();
        const fuelUsageGph = this.cachedFuelUsageGph ?? detailFuelUsageGph;
        const fuelDensity = this.cachedFuelDensityLbsPerGallon ?? (fuelUsageGph !== null ? 6.7 : null);
        return { fuelUsageGph, fuelDensity };
    }

    private extractCruiseSpeedKnots(): number | null {
        const detail = this.findAircraftDetail((entry, name) => name === "TT:MENU.ACPROPUI_CRUISE_SPEED" || name.includes("CRUISE_SPEED"));
        const value = this.parseNumericDetailValue(detail);
        return value === null ? null : this.convertToKnots(value, this.normalizeText(detail?.unit));
    }

    private extractMaxAltitudeFeet(): number | null {
        const detail = this.findAircraftDetail((entry, name) => name === "TT:MENU.ACPROPUI_MAX_ALTITUDE" || name.includes("MAX_ALTITUDE"));
        const value = this.parseNumericDetailValue(detail);
        return value === null ? null : this.convertToFeet(value, this.normalizeText(detail?.unit));
    }

    private extractRangeNm(): number | null {
        const detail = this.findAircraftDetail((entry, name, unit) =>
            name.includes("RANGE") || unit.includes("NAUTICAL_MILE") || unit.includes("KILOMETER")
        );
        const value = this.parseNumericDetailValue(detail);
        return value === null ? null : this.convertToNm(value, this.normalizeText(detail?.unit));
    }

    private extractLandingSurface(): string | null {
        const detail = this.findAircraftDetail((entry, name) => name.includes("LANDING") || name.includes("SURFACE"));
        if (!detail) {
            return null;
        }
        const valueStr = this.normalizeText(detail.valueStr);
        if (valueStr) {
            return valueStr;
        }
        const html = this.normalizeText(detail.html).toUpperCase();
        if (html.includes("SNOW")) {
            return "Snow";
        }
        if (html.includes("WATER")) {
            return "Water";
        }
        if (html.includes("ATC")) {
            return "Tower";
        }
        return null;
    }

    private extractEmptyWeightLbs(): number | null {
        const detail = this.findAircraftDetail((entry, name) =>
            name.includes("EMPTY_WEIGHT") || (name.includes("EMPTY") && name.includes("WEIGHT"))
        );
        const value = this.parseNumericDetailValue(detail);
        if (value !== null) {
            return value;
        }
        if (this.emptyWeightLbs > 0) {
            return this.emptyWeightLbs;
        }
        const simVarValue = Number(SimVar.GetSimVarValue("A:EMPTY WEIGHT", "pounds") ?? 0);
        return simVarValue > 0 ? simVarValue : null;
    }

    private extractMaxWeightLbs(): number | null {
        const detail = this.findAircraftDetail((entry, name) =>
            name.includes("MAX_WEIGHT")
            || name.includes("MAX_GROSS")
            || (name.includes("GROSS") && name.includes("WEIGHT"))
        );
        const value = this.parseNumericDetailValue(detail);
        if (value !== null) {
            return value;
        }
        return this.maxTowLbs > 0 ? this.maxTowLbs : null;
    }

    private resolveAtcTitle(): string {
        const snapshot = this.selectedPlaneSnapshot;
        const candidates = [
            this.normalizeText(snapshot?.atc_title),
            this.normalizeText(snapshot?.title),
            this.normalizeText(snapshot?.displayName),
            this.currentAircraftTitle
        ];
        return candidates.find(value => value.length > 0) ?? "";
    }

    private resolveExportStatusKey(): string {
        const snapshot = this.selectedPlaneSnapshot;
        const candidates = [
            this.currentAircraftTitle,
            this.normalizeText(snapshot?.title),
            this.normalizeText(snapshot?.displayName),
            this.normalizeText(snapshot?.atc_title),
        ];
        return candidates.find(value => value.length > 0) ?? "";
    }

    private buildAircraftExportPayload(): AircraftExportPayload {
        const atcTitle = this.resolveAtcTitle();
        const exportStatusKey = this.resolveExportStatusKey() || atcTitle;
        const fuelMetrics = this.resolveFuelUsageAndDensity();
        const totalFuelCapacityLbs = this.totalFuelCapacityGallons > 0
            ? this.totalFuelCapacityGallons * (fuelMetrics.fuelDensity ?? 6.7)
            : null;
        const pilotSeatCount = this.seatStations
            .filter(seat => seat.sectionType === 0)
            .reduce((sum, seat) => sum + seat.maxOccupation, 0);
        const copilotSeatCount = this.seatStations
            .filter(seat => seat.sectionType === 1)
            .reduce((sum, seat) => sum + seat.maxOccupation, 0);
        const passengerSeatCount = this.seatStations
            .filter(seat => seat.sectionType === 2)
            .reduce((sum, seat) => sum + seat.maxOccupation, 0);

        const payloadStations: AircraftExportPayload["mass_balance"]["payload_stations"] = {};
        for (const station of [...this.cargoStations, ...this.baggageStations]) {
            payloadStations[String(station.id)] = {
                name: station.name,
                kind: station.kind,
                max_weight_lbs: station.maxLbs > 0 ? station.maxLbs : null,
                min_weight_lbs: station.minLbs >= 0 ? station.minLbs : null
            };
        }

        return {
            atc_title: atcTitle,
            aircraft_info: {
                total_fuel_capacity_gallons: this.totalFuelCapacityGallons > 0 ? this.totalFuelCapacityGallons : null,
                total_fuel_capacity_lbs: totalFuelCapacityLbs,
                fuel_usage_gph: fuelMetrics.fuelUsageGph,
                fuel_density: fuelMetrics.fuelDensity,
                empty_weight_lbs: this.extractEmptyWeightLbs(),
                max_weight_lbs: this.extractMaxWeightLbs(),
                max_zero_fuel_weight_lbs: this.maxZfwLbs > 0 ? this.maxZfwLbs : null,
                max_takeoff_weight_lbs: this.maxTowLbs > 0 ? this.maxTowLbs : null,
                landing_surface: this.extractLandingSurface(),
                cruise_speed_knots: this.extractCruiseSpeedKnots(),
                max_altitude_feet: this.extractMaxAltitudeFeet(),
                range_nm: this.extractRangeNm()
            },
            mass_balance: {
                total_fuel_capacity_gallons: this.totalFuelCapacityGallons > 0 ? this.totalFuelCapacityGallons : null,
                max_zero_fuel_weight_lbs: this.maxZfwLbs > 0 ? this.maxZfwLbs : null,
                max_takeoff_weight_lbs: this.maxTowLbs > 0 ? this.maxTowLbs : null,
                pilot_seat_count: pilotSeatCount,
                copilot_seat_count: copilotSeatCount,
                passenger_seat_count: passengerSeatCount,
                payload_stations: payloadStations,
                seat_sections: this.seatStations.map(seat => ({
                    name: seat.sectionName,
                    section_type: seat.sectionType,
                    capacity: seat.maxOccupation
                }))
            },
            source: {
                current_aircraft_status: exportStatusKey
            }
        };
    }

    private async exportAircraftJson(): Promise<void> {
        if (!this.massBalanceListener || !this.massBalanceReady) {
            this.setResult("Mass & Balance data is not ready for export.", "#f44336");
            return;
        }
        if (!this.aircraftInfoReady) {
            this.setResult("Aircraft info listener is not ready for export.", "#f44336");
            return;
        }

        this.requestSelectedAircraftInfo();
        await new Promise(resolve => window.setTimeout(resolve, 250));
        await this.refreshMassAndBalanceData();
        await this.refreshFlightPerformanceData();

        const payload = this.buildAircraftExportPayload();
        if (typeof payload.atc_title !== "string" || payload.atc_title.length === 0) {
            this.setResult("Aircraft export failed: ATC title could not be resolved.", "#f44336");
            return;
        }

        this.setResult("Exporting aircraft JSON...", "#FFA726");
        try {
            const response = await fetch("http://127.0.0.1:5000/aircraft-export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result?.ok === false) {
                const errorText = typeof result?.error === "string" ? result.error : "unknown error";
                this.setResult(`Aircraft export failed: ${errorText}`, "#f44336");
                return;
            }
            if (result?.skipped === "already_exists") {
                this.setResult(`Aircraft export skipped: ${payload.atc_title} already exists.`, "#93c5fd");
                return;
            }
            this.setResult(`Aircraft export saved: ${payload.atc_title}`, "#4CAF50");
        } catch {
            this.setResult("Aircraft export request failed.", "#f44336");
        }
    }

    public render(): TVNode<HTMLDivElement> {
        return (
            <div ref={this.gamepadUiViewRef} style="padding: 26px; margin-top: 24px; margin-bottom: 24px; background: radial-gradient(circle at top left, #1f2937, #0b1220 55%); height: 100%; overflow-y: auto;">
                <h2 style="color: white; margin: 36px 0 12px 0; font-size: 28px; letter-spacing: 0.3px;">Skyward EFB</h2>
                <div ref={this.statusText} style="font-size: 18px; margin: 6px 0; font-weight: 600;">Connecting...</div>
                <div ref={this.aircraftText} style="font-size: 15px; color: #cbd5e1; margin-bottom: 14px;" />
                <div ref={this.gameModeDebug} style="font-size: 13px; color: #fbbf24; margin-bottom: 4px;">{this.gmStatusText}</div>
                <div ref={this.isInMenuDebug} style="font-size: 13px; color: #fbbf24; margin-bottom: 4px;">{this.menuStatusText}</div>
                <div ref={this.postDebug} style="font-size: 12px; color: #f97316; margin-bottom: 4px;">{this.postStatusText}</div>
                <div ref={this.connectionDebug} style="font-size: 12px; color: #a78bfa; margin-bottom: 12px;">{this.connectionStatusText}</div>
                <div ref={this.massSummary} style="font-size: 15px; color: #d7e3ff; margin-bottom: 14px; line-height: 1.45;" />
                <div style="color:#93c5fd; font-size:14px; margin-bottom:8px; font-weight:600;">
                    Takeoff-safe payload planner (Atlas-like):
                </div>
                <div ref={this.payloadPlanner} style="margin-bottom: 14px;" />

                <div style="color:#93c5fd; font-size:14px; margin-bottom:8px; font-weight:600;">
                    Cargo stations (weight lbs, with max limit):
                </div>
                <div ref={this.cargoEditors} style="margin-bottom: 16px; font-size: 13px; line-height: 1.6;" />

                <div style="color:#93c5fd; font-size:14px; margin-bottom:8px; font-weight:600;">
                    Baggage stations (weight lbs, with max limit):
                </div>
                <div ref={this.baggageEditors} style="margin-bottom: 16px; font-size: 13px; line-height: 1.6;" />

                <div style="color:#93c5fd; font-size:14px; margin: 8px 0; font-weight:600;">
                    Passenger/seat stations (occupancy pax, with max seat capacity):
                </div>
                <div ref={this.seatSummary} style="color:#c8d4ff; font-size:14px; margin: 0 0 10px 0;" />
                <div ref={this.seatEditors} style="margin-bottom: 16px; font-size: 13px; line-height: 1.6;" />

                <TTButton
                    key="Load Cargo Preset"
                    callback={(): void => { this.loadCargoPreset(); }}
                />
                <div style="height:8px;" />
                <TTButton
                    key="Send Plan to ATC (No Immediate Load)"
                    callback={(): void => { this.sendPlannerConfigToAtcAndOpen(); }}
                />
                <div style="height:8px; margin-bottom: 12px" />
                <TTButton
                    key="Export Aircraft JSON"
                    callback={(): void => { this.exportAircraftJson(); }}
                />

                <div ref={this.cargoResult} style="margin-top: 12px; font-size: 15px; font-weight: 600;" />
            </div>
        );
    }
}
