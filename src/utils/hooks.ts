import type { SocketMessage } from "../../types/avclient-livekit";
import LiveKitAVConfig from "../LiveKitAVConfig";
import {
  protectCameraPopoutFromEscape,
  protectRegisteredCameraPopoutsFromEscape,
} from "./cameraPopoutGuard";
import { MODULE_NAME } from "./constants";
import registerModuleSettings from "./registerModuleSettings";

/* -------------------------------------------- */
/*  Hook calls                                  */
/* -------------------------------------------- */

Hooks.on("init", () => {
  // Override voice modes
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  foundry.av.AVSettings.VOICE_MODES = {
    ALWAYS: "always",
    PTT: "ptt",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // Register module settings
  registerModuleSettings();

  // Add renderCameraViews hook after init
  Hooks.on("renderCameraViews", (cameraViews, cameraViewsElement) => {
    protectRegisteredCameraPopoutsFromEscape();
    if (game.webrtc?.client._liveKitClient) {
      game.webrtc.client._liveKitClient.onRenderCameraViews(
        cameraViews,
        cameraViewsElement,
      );
    }
  });

  // Camera popouts are created lazily. Guard each new instance after its first
  // render while leaving every other Foundry application untouched.
  Hooks.on("renderCameraPopout", (cameraPopout) => {
    protectCameraPopoutFromEscape(cameraPopout);
  });
});

Hooks.on("ready", () => {
  // Add socket listener after ready
  game.socket?.on(
    `module.${MODULE_NAME}`,
    (message: SocketMessage, userId: string) => {
      if (game.webrtc?.client._liveKitClient) {
        game.webrtc.client._liveKitClient.onSocketEvent(message, userId);
      }
    },
  );

  // Override the default settings menu with our own
  // WebRTC Control Menu
  game.settings?.registerMenu("core", "webrtc", {
    name: "WEBRTC.Title",
    label: "WEBRTC.MenuLabel",
    hint: "WEBRTC.MenuHint",
    icon: "fas fa-headset",
    type: LiveKitAVConfig,
    restricted: false,
  });
});

// Add context options on getUserContextOptions
Hooks.on("getUserContextOptions", (playersApp, contextOptions) => {
  // If the WebRTC client is available, call its method to add context options
  if (game.webrtc?.client) {
    game.webrtc.client._liveKitClient.onGetUserContextOptions(
      playersApp,
      contextOptions,
    );
  }
});
