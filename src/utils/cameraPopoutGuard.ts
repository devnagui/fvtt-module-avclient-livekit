const ESCAPE_GUARD = Symbol.for(
  "avclient-livekit.camera-popout-escape-guard",
);

export interface CameraPopoutCloseOptions {
  closeKey?: boolean;
  [key: string]: unknown;
}

export interface CameraPopoutLike {
  id?: string;
  element?: HTMLElement;
  close: (...args: unknown[]) => unknown;
  [ESCAPE_GUARD]?: boolean;
}

function isCameraPopout(application: unknown): application is CameraPopoutLike {
  if (!application || typeof application !== "object") {
    return false;
  }

  const candidate = application as Partial<CameraPopoutLike>;
  if (typeof candidate.close !== "function") {
    return false;
  }

  if (candidate.id?.startsWith("camera-view-") === true) {
    return true;
  }
  return candidate.element?.matches(".camera-view.popout") ?? false;
}

/**
 * Prevent only Escape-key closure of a detached camera application.
 * Every explicit and programmatic close path continues to call Foundry's
 * original method. The global symbol makes wrapping idempotent across renders
 * and development hot reloads.
 */
export function protectCameraPopoutFromEscape(application: unknown): boolean {
  if (!isCameraPopout(application) || application[ESCAPE_GUARD]) {
    return false;
  }

  const originalClose = application.close;
  application.close = function (
    this: CameraPopoutLike,
    ...args: unknown[]
  ): unknown {
    const options = args[0] as CameraPopoutCloseOptions | undefined;
    if (options?.closeKey === true) {
      return undefined;
    }
    return originalClose.apply(this, args);
  };
  Object.defineProperty(application, ESCAPE_GUARD, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return true;
}

/** Find a camera popout in either the Foundry v14 or legacy v13 registry. */
export function getRegisteredCameraPopout(
  userId: string,
): CameraPopoutLike | undefined {
  const applicationId = `camera-view-${userId}`;
  const modernInstances = Reflect.get(
    foundry.applications,
    "instances",
  ) as Map<string, unknown> | undefined;
  const modernApplication = modernInstances?.get(applicationId);
  if (isCameraPopout(modernApplication)) {
    return modernApplication;
  }

  const legacyWindows = Reflect.get(ui, "windows") as
    | Record<string, unknown>
    | undefined;
  return Object.values(legacyWindows ?? {}).find((application): application is CameraPopoutLike => {
    return isCameraPopout(application) && application.id === applicationId;
  });
}

/** Protect camera popouts already registered by either Foundry v13 or v14. */
export function protectRegisteredCameraPopoutsFromEscape(): void {
  const modernInstances = Reflect.get(
    foundry.applications,
    "instances",
  ) as Map<string, unknown> | undefined;
  if (modernInstances) {
    for (const application of modernInstances.values()) {
      protectCameraPopoutFromEscape(application);
    }
  }

  // v13 compatibility fallback for applications exposed through ui.windows.
  const legacyWindows = Reflect.get(ui, "windows") as
    | Record<string, unknown>
    | undefined;
  for (const application of Object.values(legacyWindows ?? {})) {
    protectCameraPopoutFromEscape(application);
  }
}
