import { PreviewRuntimeMocks, PreviewScenario } from "./types";

export function installPreviewRuntimeMocks(initialScenario: PreviewScenario): PreviewRuntimeMocks {
    let currentScenario = initialScenario;
    const previewWindow: any = window;
    const originalFetch = globalThis.fetch?.bind(globalThis);
    const originalSimVar = previewWindow.SimVar;
    const originalRegisterViewListener = previewWindow.RegisterViewListener;
    const originalLaunchFlowEventToGlobalFlow = previewWindow.LaunchFlowEventToGlobalFlow;
    const originalGameModeManager = previewWindow.GAME_MODE_MANAGER;

    const previewFetch: typeof fetch = async (input, init) => {
        const requestUrl = typeof input === "string"
            ? input
            : input instanceof Request
                ? input.url
                : input.toString();
        if (requestUrl.endsWith("/status") || requestUrl === "/status") {
            return new Response(JSON.stringify(currentScenario.status), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (requestUrl.endsWith("/aircraft-export") || requestUrl === "/aircraft-export") {
            return new Response(JSON.stringify({ ok: true, mocked: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (originalFetch) {
            return originalFetch(input, init);
        }
        return Promise.reject(new Error(`No preview fetch handler registered for '${requestUrl}'.`));
    };

    previewWindow.SimVar = {
        GetSimVarValue: (): number => 0,
        SetSimVarValue: async (): Promise<void> => undefined,
    };

    previewWindow.RegisterViewListener = (_listenerName: string, onRegistered?: () => void) => {
        onRegistered?.();
        return {
            call: async (): Promise<unknown> => [],
            on: (): void => undefined,
            trigger: (): void => undefined,
        };
    };

    previewWindow.LaunchFlowEventToGlobalFlow = (): void => undefined;
    previewWindow.GAME_MODE_MANAGER = {
        gameMode: {
            sub: (cb: (value: number) => void): any => {
                cb(4);
                return {
                    isAlive: true,
                    isPaused: false,
                    canInitialNotify: true,
                    pause: function (): any { return this; },
                    resume: function (): any { return this; },
                    destroy: (): void => undefined,
                };
            },
        },
        isInMenu: {
            sub: (cb: (value: boolean) => void): any => {
                cb(false);
                return {
                    isAlive: true,
                    isPaused: false,
                    canInitialNotify: true,
                    pause: function (): any { return this; },
                    resume: function (): any { return this; },
                    destroy: (): void => undefined,
                };
            },
        },
        setBus: (): void => undefined,
    };

    globalThis.fetch = previewFetch;

    return {
        setScenario: (scenario: PreviewScenario): void => {
            currentScenario = scenario;
        },
        restore: (): void => {
            if (originalFetch) {
                globalThis.fetch = originalFetch;
            }
            previewWindow.SimVar = originalSimVar;
            previewWindow.RegisterViewListener = originalRegisterViewListener;
            previewWindow.LaunchFlowEventToGlobalFlow = originalLaunchFlowEventToGlobalFlow;
            previewWindow.GAME_MODE_MANAGER = originalGameModeManager;
        },
    };
}
