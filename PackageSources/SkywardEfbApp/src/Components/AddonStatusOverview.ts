declare const BASE_URL: string;

export type OverviewStatusInput = {
    airport_match?: boolean;
    aircraft_match?: boolean;
    payload_match?: boolean;
    flight_progress?: string[];
    flight_state?: string;
    parked_label?: string;
    sim_utc_hour?: number | null;
    sim_utc_minute?: number | null;
    active_sim_state_label?: string;
};

export interface OverviewCardViewModel {
    title: string;
    statusText: string;
    backgroundImage: string;
}

export interface OverviewViewModel {
    showEnRoute: boolean;
    enRouteImage: string;
    cards: {
        airport: OverviewCardViewModel;
        aircraft: OverviewCardViewModel;
        payload: OverviewCardViewModel;
    };
    progressText: string;
    parkedText: string;
    simUtcText: string;
    simStateText: string;
}

const simStateAssets = {
    airport: {
        match: `${BASE_URL}/Assets/sim_states/pilot_airport_match.png`,
        mismatch: `${BASE_URL}/Assets/sim_states/pilot_airport_mismatch.png`,
    },
    aircraft: {
        match: `${BASE_URL}/Assets/sim_states/pilot_aircraft_match.png`,
        mismatch: `${BASE_URL}/Assets/sim_states/pilot_aircraft_mismatch.png`,
    },
    payload: {
        match: `${BASE_URL}/Assets/sim_states/payload_match.png`,
        mismatch: `${BASE_URL}/Assets/sim_states/payload_mismatch.png`,
    },
    enRoute: `${BASE_URL}/Assets/sim_states/pilot_in_flight_panaromic.png`,
} as const;

function formatMatchText(title: string, isMatch: boolean): string {
    return `${title} ${isMatch ? "match" : "mismatch"}`;
}

function formatSimUtc(hour?: number | null, minute?: number | null): string {
    if (typeof hour === "number" && typeof minute === "number") {
        return `Sim UTC: ${hour.toString().padStart(2, "0")}:${minute
            .toString()
            .padStart(2, "0")}`;
    }
    return "Sim UTC: --:--";
}

function formatProgress(progress?: string[]): string {
    if (Array.isArray(progress) && progress.length > 0) {
        return `Flight progress: ${progress.join(" -> ")}`;
    }
    return "Flight progress: waiting for cold start sequence";
}

function formatSimState(label?: string): string {
    return label ? `Sim State: ${label}` : "Sim State: -";
}

function buildCardViewModel(
    title: string,
    isMatch: boolean | undefined,
    matchImage: string,
    mismatchImage: string,
): OverviewCardViewModel {
    const resolvedMatch = Boolean(isMatch);
    return {
        title,
        statusText: formatMatchText(title, resolvedMatch),
        backgroundImage: resolvedMatch ? matchImage : mismatchImage,
    };
}

export function buildOverviewViewModel(status: OverviewStatusInput): OverviewViewModel {
    const flightState = typeof status.flight_state === "string" ? status.flight_state.trim() : "";
    const showEnRoute = flightState.length > 0 && flightState !== "SHUTDOWN_COMPLETE";

    return {
        showEnRoute,
        enRouteImage: simStateAssets.enRoute,
        cards: {
            airport: buildCardViewModel(
                "Airport",
                status.airport_match,
                simStateAssets.airport.match,
                simStateAssets.airport.mismatch,
            ),
            aircraft: buildCardViewModel(
                "Aircraft",
                status.aircraft_match,
                simStateAssets.aircraft.match,
                simStateAssets.aircraft.mismatch,
            ),
            payload: buildCardViewModel(
                "Payload",
                status.payload_match,
                simStateAssets.payload.match,
                simStateAssets.payload.mismatch,
            ),
        },
        progressText: formatProgress(status.flight_progress),
        parkedText: status.parked_label ? status.parked_label : "",
        simUtcText: formatSimUtc(status.sim_utc_hour, status.sim_utc_minute),
        simStateText: formatSimState(status.active_sim_state_label),
    };
}
