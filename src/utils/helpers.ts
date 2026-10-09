import { Logger } from "./logger";

const log = new Logger();

/**
 * Typescript Interfaces
 */

// AV Device Info object
interface DeviceInfo {
  deviceId: string;
  groupId: string;
  label: string;
  kind: "audio" | "video";
}

/**
 * Helper methods
 */

/**
 * Issue a delayed (debounced) reload to the whole window.
 * Allows settings to get saved before reload
 */
export const delayReload: () => void = foundry.utils.debounce(() => {
  window.location.reload();
}, 100);

export const debounceRender: () => void = foundry.utils.debounce(
  () => game.webrtc?.render(),
  200,
);

const refreshViewTimeouts = new Map<string, number>();

export const debounceRefreshView = (userId: string): void => {
  const existingTimeout = refreshViewTimeouts.get(userId);
  if (existingTimeout !== undefined) {
    window.clearTimeout(existingTimeout);
  }

  const timeout = window.setTimeout(() => {
    refreshViewTimeouts.delete(userId);
    // User IDs are dynamic CameraViews parts in Foundry v14 and disappear from
    // the supported part registry when a receiver blocks that user. A partial
    // render can therefore warn or fail during hide/show transitions. A full
    // render is the stable API shared by Foundry v13 and v14.
    Promise.resolve(ui.webrtc?.render()).catch((error: unknown) => {
      log.error("Error refreshing camera views:", error);
    });
  }, 200);
  refreshViewTimeouts.set(userId, timeout);
};

export const sleep: (delay: number) => Promise<void> = (delay: number) =>
  new Promise((resolve) => setTimeout(resolve, delay));

export function callWhenReady(fnToCall: () => unknown): void {
  if (game.ready) {
    log.debug("callWhenReady now", fnToCall);
    fnToCall();
  } else {
    log.debug("callWhenReady ready", fnToCall);
    Hooks.once("ready", fnToCall);
  }
}

/**
 * Transform the device info array from enumerated devices into an object with {id: label} keys
 * @param {Array} list    The list of devices
 */
export function deviceInfoToObject(
  list: DeviceInfo[],
  kind: "audio" | "video",
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const device of list) {
    if (device.kind === kind) {
      obj[device.deviceId] =
        (device.label || game.i18n?.localize("WEBRTC.UnknownDevice")) ??
        "unknown";
    }
  }

  return obj;
}
