import { GamepadUiView, RequiredProps, TVNode, UiViewProps } from "@efb/efb-api";
import { FSComponent, NodeReference } from "@microsoft/msfs-sdk";
import { buildOverviewViewModel, OverviewViewModel } from "./AddonStatusOverview";
import { GameStateReading, GameStateTracker } from "../GameStateTracker";
import { syncOverviewCardLayout } from "./OverviewCardLayout";
import { PanelLayoutController } from "./PanelLayoutController";

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
    airport_match?: boolean;
    aircraft_match?: boolean;
    payload_match?: boolean;
    required_airport?: string;
    required_aircraft?: string;
    required_payload_lbs?: number | null;
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
    flight_state?: string;
    flight_progress?: string[];
    parked_label?: string;
    sim_utc_hour?: number | null;
    sim_utc_minute?: number | null;
    active_sim_state_label?: string;
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

type CaptureSource = "event" | "snapshot" | "hydrate" | "cache";

interface RawStateSample {
    gameMode: number;
    isInMenu: boolean;
    label: string;
    source: CaptureSource;
    gameModeTrusted: boolean;
    isInMenuTrusted: boolean;
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

type ActiveSection = "overview" | "simconnect" | "payload";

export class AddonStatus extends GamepadUiView<HTMLDivElement, AddonStatusProps> {
    public readonly tabName = AddonStatus.name;
    private static readonly STATE_CONFIRM_MS = 250;
    private static readonly DEFAULT_PAX_WEIGHT_LBS = 170;
    private static readonly EFB_STATE_HEARTBEAT_MS = 2000;
    private static readonly MASS_BALANCE_HEARTBEAT_MS = 2000;

    private readonly overviewSection = FSComponent.createRef<HTMLDivElement>();
    private readonly simconnectSection = FSComponent.createRef<HTMLDivElement>();
    private readonly payloadSection = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewNavButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly simconnectNavButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly payloadNavButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly loadCargoPresetButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly sendPlanButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly exportAircraftButton = FSComponent.createRef<HTMLButtonElement>();
    private readonly airportText = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewGrid = FSComponent.createRef<HTMLDivElement>();
    private readonly enRouteCard = FSComponent.createRef<HTMLDivElement>();
    private readonly enRouteCardMedia = FSComponent.createRef<HTMLImageElement>();
    private readonly airportCard = FSComponent.createRef<HTMLDivElement>();
    private readonly aircraftCard = FSComponent.createRef<HTMLDivElement>();
    private readonly payloadCard = FSComponent.createRef<HTMLDivElement>();
    private readonly airportCardMedia = FSComponent.createRef<HTMLImageElement>();
    private readonly aircraftCardMedia = FSComponent.createRef<HTMLImageElement>();
    private readonly payloadCardMedia = FSComponent.createRef<HTMLImageElement>();
    private readonly airportCardText = FSComponent.createRef<HTMLDivElement>();
    private readonly aircraftCardText = FSComponent.createRef<HTMLDivElement>();
    private readonly payloadCardText = FSComponent.createRef<HTMLDivElement>();
    private readonly airportCardDetail = FSComponent.createRef<HTMLDivElement>();
    private readonly aircraftCardDetail = FSComponent.createRef<HTMLDivElement>();
    private readonly payloadCardDetail = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewProgress = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewParked = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewUtc = FSComponent.createRef<HTMLDivElement>();
    private readonly overviewSimState = FSComponent.createRef<HTMLDivElement>();

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
    private overviewLayoutRaf?: number;
    private panelLayoutController?: PanelLayoutController;

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

    private gameStateSub?: { destroy: () => void };
    private isDestroyed = false;
    private readonly clientStartedAtMs = Date.now();
    private readonly clientSessionId = `efb-${this.clientStartedAtMs}-${Math.random().toString(36).slice(2, 10)}`;
    private efbStateSeq = 0;
    private lastPostedSeq?: number;
    private lastPostedAtMs?: number;
    private pushQueued = false;
    private pushInFlight = false;
    private pendingRepostReason?: string;
    private confirmStateTimer?: number;
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
    private activeSection: ActiveSection = "overview";

    public onAfterRender(): void {
        if (this.gamepadUiViewRef.instance) {
            this.panelLayoutController = new PanelLayoutController(
                this.gamepadUiViewRef.instance,
                () => { this.scheduleOverviewLayoutSync(); },
            );
            this.panelLayoutController.start();
        }
        this.syncSectionVisibility();
        this.bindStaticButtonHandlers();
        this.updateOverview(buildOverviewViewModel({}));
        this.fetchStatus();
        this.initMassBalanceListener();
        this.initAircraftInfoListener();
        this.initFlightPerformanceListener();
        this.initGameStateTracking();

        this.statusTimer = window.setInterval(() => this.fetchStatus(), 3000);
        this.refreshTimer = window.setInterval(() => this.refreshMassAndBalanceData(), 2000);
        this.heartbeatTimer = window.setInterval(
            () => this.maybeHeartbeatConfirmedState(),
            AddonStatus.EFB_STATE_HEARTBEAT_MS
        );
    }

    public destroy(): void {
        this.isDestroyed = true;
        this.panelLayoutController?.destroy();
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
        if (this.overviewLayoutRaf !== undefined) {
            window.cancelAnimationFrame(this.overviewLayoutRaf);
        }
        if (this.confirmStateTimer !== undefined) {
            window.clearTimeout(this.confirmStateTimer);
        }
        if (this.gameStateSub) {
            this.gameStateSub.destroy();
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

    private initGameStateTracking(): void {
        if (this.isDestroyed || this.gameStateSub) {
            return;
        }
        if (this.props?.appViewService?.bus) {
            GameStateTracker.instance.initialize(this.props.appViewService.bus);
        }

        this.gameStateSub = GameStateTracker.instance.sub((reading: GameStateReading) => {
            this.captureGameStateReading(reading, reading.source === "event" ? "tracker_event" : "tracker_update");
        });

        if (!GameStateTracker.instance.getCurrentReading()) {
            this.updateGameModeDebug("GameMode: (warming)");
            this.updateIsInMenuDebug("IsInMenu: (warming)");
        }
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

    private setSection(section: ActiveSection): void {
        this.activeSection = section;
        this.syncSectionVisibility();
    }

    private scheduleOverviewLayoutSync(): void {
        if (this.overviewLayoutRaf !== undefined) {
            window.cancelAnimationFrame(this.overviewLayoutRaf);
        }

        this.overviewLayoutRaf = window.requestAnimationFrame(() => {
            this.overviewLayoutRaf = undefined;
            if (this.gamepadUiViewRef.instance) {
                syncOverviewCardLayout(this.gamepadUiViewRef.instance);
            }
        });
    }

    private bindStaticButtonHandlers(): void {
        const bindings: Array<[NodeReference<HTMLButtonElement>, () => void]> = [
            [this.overviewNavButton, () => { this.setSection("overview"); }],
            [this.simconnectNavButton, () => { this.setSection("simconnect"); }],
            [this.payloadNavButton, () => { this.setSection("payload"); }],
            [this.loadCargoPresetButton, () => { this.loadCargoPreset(); }],
            [this.sendPlanButton, () => { this.sendPlannerConfigToAtcAndOpen(); }],
            [this.exportAircraftButton, () => { this.exportAircraftJson(); }],
        ];

        for (const [ref, handler] of bindings) {
            if (ref.instance) {
                ref.instance.onclick = handler;
            }
        }
    }

    private syncSectionVisibility(): void {
        const sectionEntries: Array<[ActiveSection, typeof this.overviewSection]> = [
            ["overview", this.overviewSection],
            ["simconnect", this.simconnectSection],
            ["payload", this.payloadSection],
        ];
        const buttonEntries: Array<[ActiveSection, typeof this.overviewNavButton]> = [
            ["overview", this.overviewNavButton],
            ["simconnect", this.simconnectNavButton],
            ["payload", this.payloadNavButton],
        ];

        for (const [section, ref] of sectionEntries) {
            if (!ref.instance) {
                continue;
            }
            ref.instance.classList.toggle("skyward-section--hidden", this.activeSection !== section);
        }

        for (const [section, ref] of buttonEntries) {
            if (!ref.instance) {
                continue;
            }
            ref.instance.classList.toggle("skyward-sidebar__button--active", this.activeSection === section);
        }

        this.scheduleOverviewLayoutSync();
    }

    private setStatusTone(
        ref: { instance: HTMLElement | null },
        tone: "success" | "danger" | "warning" | "info",
        baseClass = "skyward-status-line",
    ): void {
        if (!ref.instance) {
            return;
        }
        ref.instance.className = `${baseClass} ${baseClass}--${tone}`;
    }

    private setResult(text: string, toneColor: string): void {
        if (!this.cargoResult.instance) {
            return;
        }

        let tone: "success" | "danger" | "warning" | "info" = "info";
        switch (toneColor) {
            case "#4CAF50":
                tone = "success";
                break;
            case "#f44336":
                tone = "danger";
                break;
            case "#FFA726":
                tone = "warning";
                break;
            default:
                tone = "info";
                break;
        }

        this.cargoResult.instance.textContent = text;
        this.setStatusTone(this.cargoResult, tone, "skyward-result");
    }

    private setEmptyState(container: HTMLElement, text: string): void {
        container.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "skyward-empty-state";
        empty.textContent = text;
        container.appendChild(empty);
    }

    private updateOverview(model: OverviewViewModel): void {
        if (this.overviewGrid.instance) {
            this.overviewGrid.instance.classList.toggle("skyward-overview-grid--hidden", model.showEnRoute);
        }
        if (this.enRouteCard.instance) {
            this.enRouteCard.instance.classList.toggle("skyward-overview-enroute--visible", model.showEnRoute);
        }
        if (this.enRouteCardMedia.instance) {
            this.enRouteCardMedia.instance.src = model.enRouteImage;
        }

        const cardMap = [
            [this.airportCardMedia, this.airportCardText, this.airportCardDetail, model.cards.airport],
            [this.aircraftCardMedia, this.aircraftCardText, this.aircraftCardDetail, model.cards.aircraft],
            [this.payloadCardMedia, this.payloadCardText, this.payloadCardDetail, model.cards.payload],
        ] as const;

        for (const [mediaRef, textRef, detailRef, card] of cardMap) {
            if (mediaRef.instance) {
                mediaRef.instance.src = card.backgroundImage;
            }
            if (textRef.instance) {
                textRef.instance.textContent = card.statusText;
                textRef.instance.classList.toggle(
                    "skyward-image-card__body--compact",
                    card.statusText.length > 42 || card.detailText.length > 26,
                );
            }
            if (detailRef.instance) {
                detailRef.instance.textContent = card.detailText;
                detailRef.instance.classList.toggle("skyward-image-card__detail--hidden", card.detailText.length === 0);
            }
        }

        if (this.overviewProgress.instance) {
            this.overviewProgress.instance.textContent = model.progressText;
        }
        if (this.overviewParked.instance) {
            this.overviewParked.instance.textContent = model.parkedText;
            this.overviewParked.instance.classList.toggle("skyward-meta-row--hidden", model.parkedText.length === 0);
        }
        if (this.overviewUtc.instance) {
            this.overviewUtc.instance.textContent = model.simUtcText;
        }
        if (this.overviewSimState.instance) {
            this.overviewSimState.instance.textContent = model.simStateText;
        }

        this.scheduleOverviewLayoutSync();
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
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = `skyward-action-button skyward-action-button--${variant}`;
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
        const canonicalUiState = this.deriveCanonicalUiState(
            state.gameMode,
            state.isInMenu,
            state.gameModeTrusted,
            state.isInMenuTrusted,
        );
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
                    game_mode_trusted: state.gameModeTrusted,
                    is_in_menu_trusted: state.isInMenuTrusted,
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
            this.updateOverview(buildOverviewViewModel(data));

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
            }
            this.setStatusTone(this.statusText, data.simconnect_connected ? "success" : "danger");

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
            if (this.airportText.instance) {
                this.airportText.instance.textContent = data.current_airport
                    ? `Airport: ${data.current_airport}`
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
            }
            this.setStatusTone(this.statusText, "danger");
            this.updateOverview(buildOverviewViewModel({}));
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

    private captureGameStateReading(reading: GameStateReading, reason: string): void {
        const nowMs = Date.now();
        const snapshot: RawStateSample = {
            gameMode: reading.gameMode,
            isInMenu: reading.isInMenu,
            label: reading.label,
            source: reading.source as CaptureSource,
            gameModeTrusted: reading.gameModeTrusted,
            isInMenuTrusted: reading.isInMenuTrusted,
            firstSeenAtMs: nowMs,
            lastSeenAtMs: nowMs,
            signature: `${reading.gameMode}|${reading.isInMenu}|${reading.gameModeTrusted}|${reading.isInMenuTrusted}`
        };
        this.recordRawState(snapshot);
        this.updateGameModeDebug(
            `GameMode: ${snapshot.gameMode} ${snapshot.label || "(empty)"} `
            + `| source=${snapshot.source} | trusted=${snapshot.gameModeTrusted}`
        );
        this.updateIsInMenuDebug(
            `IsInMenu: ${snapshot.isInMenu} | pending=${this.confirmedState?.signature === snapshot.signature ? "confirmed" : "pending"} `
            + `| trusted=${reading.isInMenuTrusted}`
        );
        this.scheduleConfirmation(snapshot.signature, reason);
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

    private deriveCanonicalUiState(
        gameMode: number,
        isInMenu: boolean,
        gameModeTrusted: boolean,
        isInMenuTrusted: boolean,
    ): string {
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
        if (gameMode === 0 && isInMenu === false) {
            return "IN_FLIGHT";
        }
        if (gameMode === 0 && isInMenu === true && gameModeTrusted === true) {
            return "MAIN_MENU";
        }
        if (gameMode === 0 && isInMenu === true && gameModeTrusted === false) {
            return "PAUSED";
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
                this.setResult("Mass & Balance data could not be read.", "#f44336");
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
            this.setEmptyState(this.payloadPlanner.instance, "Payload planner data is not ready.");
            return;
        }

        const container = document.createElement("div");
        container.className = "skyward-planner";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.value = this.plannerPercent.toString();
        slider.className = "skyward-planner__slider";

        const pctInput = document.createElement("input");
        pctInput.type = "number";
        pctInput.min = "0";
        pctInput.max = "100";
        pctInput.step = "1";
        pctInput.value = this.plannerPercent.toString();
        pctInput.className = "skyward-editor-input";

        const applyBtn = this.createActionButton(
            "Apply TO-safe",
            (): void => { this.applyTakeoffSafePayload(Number(slider.value)); },
            "green",
        );
        applyBtn.classList.add("skyward-action-button--wide");

        const detail = document.createElement("div");
        detail.className = "skyward-planner__detail";

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
            this.setEmptyState(this.cargoEditors.instance, "No cargo station found for this aircraft.");
            return;
        }

        for (const station of this.cargoStations) {
            const row = document.createElement("div");
            row.className = "skyward-editor-row";

            const info = document.createElement("div");
            info.className = "skyward-editor-row__info";
            info.textContent =
                `Cargo ${station.id} (${station.name})  Current: ${station.massLbs.toFixed(1)} lbs  Max: ${station.maxLbs.toFixed(1)} lbs`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = station.minLbs.toString();
            input.max = station.maxLbs.toString();
            input.value = this.cargoDraftValues.get(station.id) ?? station.massLbs.toFixed(0);
            input.className = "skyward-editor-input";
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
            this.setEmptyState(this.baggageEditors.instance, "No baggage station found for this aircraft.");
            return;
        }

        for (const station of this.baggageStations) {
            const row = document.createElement("div");
            row.className = "skyward-editor-row";

            const info = document.createElement("div");
            info.className = "skyward-editor-row__info";
            info.textContent =
                `Baggage ${station.id} (${station.name})  Current: ${station.massLbs.toFixed(1)} lbs  Max: ${station.maxLbs.toFixed(1)} lbs`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = station.minLbs.toString();
            input.max = station.maxLbs.toString();
            input.value = this.cargoDraftValues.get(station.id) ?? station.massLbs.toFixed(0);
            input.className = "skyward-editor-input";
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
            this.setEmptyState(this.seatEditors.instance, "No passenger seat section found for this aircraft.");
            return;
        }

        for (const seat of editableSeats) {
            const row = document.createElement("div");
            row.className = "skyward-editor-row";

            const info = document.createElement("div");
            info.className = "skyward-editor-row__info";
            const seatRole = "Passenger seat";
            info.textContent =
                `${seat.sectionName} (${seatRole})  Current Pax: ${seat.currentOccupation}  Max Pax: ${seat.maxOccupation}`;

            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = "0";
            input.max = seat.maxOccupation.toString();
            input.value = this.seatDraftValues.get(seat.key) ?? seat.currentOccupation.toString();
            input.className = "skyward-editor-input";
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

    private renderSidebarButton(
        label: string,
        section: ActiveSection,
        ref: NodeReference<HTMLButtonElement>,
    ): TVNode<HTMLButtonElement> {
        return (
            <button
                ref={ref}
                type="button"
                class="skyward-sidebar__button"
                data-section={section}
            >
                {label}
            </button>
        );
    }

    private renderOverviewCard(
        title: string,
        cardRef: NodeReference<HTMLDivElement>,
        mediaRef: NodeReference<HTMLImageElement>,
        textRef: NodeReference<HTMLDivElement>,
        detailRef: NodeReference<HTMLDivElement>,
    ): TVNode<HTMLDivElement> {
        return (
            <div ref={cardRef} class="skyward-image-card skyward-image-card--square skyward-overview-card">
                <img ref={mediaRef} class="skyward-image-card__media" alt="" />
                <div class="skyward-image-card__overlay" />
                <div class="skyward-image-card__content">
                    <div class="skyward-image-card__eyebrow">{title}</div>
                    <div class="skyward-image-card__footer">
                        <div ref={textRef} class="skyward-image-card__body" />
                        <div ref={detailRef} class="skyward-image-card__detail skyward-image-card__detail--hidden" />
                    </div>
                </div>
            </div>
        );
    }

    private renderOverviewSection(): TVNode<HTMLDivElement> {
        return (
            <section ref={this.overviewSection} class="skyward-section skyward-section--overview">
                <div ref={this.overviewGrid} class="skyward-overview-grid">
                    {this.renderOverviewCard("Airport", this.airportCard, this.airportCardMedia, this.airportCardText, this.airportCardDetail)}
                    {this.renderOverviewCard("Aircraft", this.aircraftCard, this.aircraftCardMedia, this.aircraftCardText, this.aircraftCardDetail)}
                    {this.renderOverviewCard("Payload", this.payloadCard, this.payloadCardMedia, this.payloadCardText, this.payloadCardDetail)}
                </div>

                <div ref={this.enRouteCard} class="skyward-image-card skyward-image-card--panoramic skyward-overview-enroute">
                    <img ref={this.enRouteCardMedia} class="skyward-image-card__media" alt="" />
                    <div class="skyward-image-card__overlay" />
                    <div class="skyward-image-card__center-label">En Route</div>
                </div>

                <div class="skyward-meta-list">
                    <div ref={this.overviewProgress} class="skyward-meta-row" />
                    <div ref={this.overviewParked} class="skyward-meta-row skyward-meta-row--hidden" />
                    <div ref={this.overviewUtc} class="skyward-meta-row" />
                    <div ref={this.overviewSimState} class="skyward-meta-row" />
                </div>
            </section>
        );
    }

    private renderSimConnectSection(): TVNode<HTMLDivElement> {
        return (
            <section ref={this.simconnectSection} class="skyward-section skyward-section--simconnect skyward-section--hidden">
                <div class="skyward-section__header">
                    <h2 class="skyward-section__title">SimConnect</h2>
                    <p class="skyward-section__subtitle">Connection, game state capture and EFB posting diagnostics.</p>
                </div>

                <div ref={this.statusText} class="skyward-status-line">Connecting...</div>
                <div ref={this.aircraftText} class="skyward-info-line" />
                <div ref={this.airportText} class="skyward-info-line" />
                <div ref={this.gameModeDebug} class="skyward-debug-line skyward-debug-line--warning">{this.gmStatusText}</div>
                <div ref={this.isInMenuDebug} class="skyward-debug-line skyward-debug-line--warning">{this.menuStatusText}</div>
                <div ref={this.postDebug} class="skyward-debug-line skyward-debug-line--danger">{this.postStatusText}</div>
                <div ref={this.connectionDebug} class="skyward-debug-line skyward-debug-line--info">{this.connectionStatusText}</div>
            </section>
        );
    }

    private renderPayloadSection(): TVNode<HTMLDivElement> {
        return (
            <section ref={this.payloadSection} class="skyward-section skyward-section--hidden">
                <div class="skyward-section__header">
                    <h2 class="skyward-section__title">Payload</h2>
                    <p class="skyward-section__subtitle">Mass and balance planning, live payload editing and aircraft export.</p>
                </div>

                <div ref={this.massSummary} class="skyward-payload-summary" />

                <div class="skyward-subsection">
                    <div class="skyward-subsection__title">Takeoff-safe payload planner (Atlas-like):</div>
                    <div ref={this.payloadPlanner} />
                </div>

                <div class="skyward-subsection">
                    <div class="skyward-subsection__title">Cargo stations (weight lbs, with max limit):</div>
                    <div ref={this.cargoEditors} class="skyward-editor-list" />
                </div>

                <div class="skyward-subsection">
                    <div class="skyward-subsection__title">Baggage stations (weight lbs, with max limit):</div>
                    <div ref={this.baggageEditors} class="skyward-editor-list" />
                </div>

                <div class="skyward-subsection">
                    <div class="skyward-subsection__title">Passenger/seat stations (occupancy pax, with max seat capacity):</div>
                    <div ref={this.seatSummary} class="skyward-seat-summary" />
                    <div ref={this.seatEditors} class="skyward-editor-list" />
                </div>

                <div class="skyward-action-group">
                    <button
                        ref={this.loadCargoPresetButton}
                        type="button"
                        class="skyward-action-button skyward-action-button--blue"
                    >
                        Load Cargo Preset
                    </button>
                    <button
                        ref={this.sendPlanButton}
                        type="button"
                        class="skyward-action-button skyward-action-button--teal"
                    >
                        Send Plan to ATC (No Immediate Load)
                    </button>
                    <button
                        ref={this.exportAircraftButton}
                        type="button"
                        class="skyward-action-button skyward-action-button--blue"
                    >
                        Export Aircraft JSON
                    </button>
                </div>

                <div ref={this.cargoResult} class="skyward-result" />
            </section>
        );
    }

    public render(): TVNode<HTMLDivElement> {
        return (
            <div ref={this.gamepadUiViewRef} class="skyward-efb-shell">
                <aside class="skyward-sidebar">
                    <div class="skyward-sidebar__brand">
                        <div class="skyward-sidebar__title">Skyward EFB</div>
                        <div class="skyward-sidebar__subtitle">Internal app sections</div>
                    </div>
                    <nav class="skyward-sidebar__nav">
                        {this.renderSidebarButton("Overview", "overview", this.overviewNavButton)}
                        {this.renderSidebarButton("SimConnect", "simconnect", this.simconnectNavButton)}
                        {this.renderSidebarButton("Payload", "payload", this.payloadNavButton)}
                    </nav>
                </aside>

                <main class="skyward-content">
                    {this.renderOverviewSection()}
                    {this.renderSimConnectSection()}
                    {this.renderPayloadSection()}
                </main>
            </div>
        );
    }
}
