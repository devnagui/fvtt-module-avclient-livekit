import {
  AudioCaptureOptions,
  ConnectionQuality,
  createLocalAudioTrack,
  createLocalScreenTracks,
  createLocalVideoTrack,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  Participant,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  RoomOptions,
  ConnectionState,
  Track,
  TrackPublication,
  VideoCaptureOptions,
  VideoPresets43,
  VideoTrack,
  DisconnectReason,
  AudioPresets,
  AudioPreset,
  TrackPublishOptions,
} from "livekit-client";
import {
  NoiseSuppressorFilter,
  isNoiseSuppressionSupported,
  toNoiseSuppressorModel,
  NOISE_SUPPRESSION_SAMPLE_RATE,
  type NoiseSuppressorModel,
} from "./NoiseSuppressorFilter";
import { LANG_NAME, MODULE_NAME } from "./utils/constants";
import LiveKitAVClient from "./LiveKitAVClient";
import {
  LiveKitServerType,
  LiveKitServerTypes,
  SocketMessage,
} from "../types/avclient-livekit";
import { addContextOptions, breakout } from "./LiveKitBreakout";
import { Logger } from "./utils/logger";
import { getAccessToken, getTavernAccessToken } from "./utils/auth";
import { debounceRefreshView } from "./utils/helpers";
import { NoiseGateFilter, isNoiseGateSupported } from "./NoiseGateFilter";

const log = new Logger();

export enum InitState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Initialized = "initialized",
}

export default class LiveKitClient {
  avMaster: foundry.av.AVMaster;
  liveKitAvClient: LiveKitAVClient;
  settings: foundry.av.AVSettings;
  render: () => void;

  audioBroadcastEnabled = false;
  private audioOperation: Promise<void> = Promise.resolve();
  audioTrack: LocalAudioTrack | null = null;
  audioProcessorContext?: AudioContext;
  noiseModelMenu: HTMLElement | null = null;
  noiseModelMenuDismiss: ((event: Event) => void) | null = null;
  noiseModelMenuTimeout: number | null = null;
  scheduleAudioSourceChange: () => void = () => undefined;
  breakoutRoom: string | undefined;
  connectionState: ConnectionState = ConnectionState.Disconnected;
  initState: InitState = InitState.Uninitialized;
  liveKitParticipants = new Map<string, Participant>();
  liveKitRoom: Room | null = null;
  private participantCallbacksConfigured = new WeakSet<Participant>();
  restoreCameraAfterScreenShare = false;
  screenSharePending = false;
  screenTracks: LocalTrack[] = [];
  useExternalAV = false;
  private videoOperation: Promise<void> = Promise.resolve();
  videoTrack: LocalVideoTrack | null = null;
  windowClickListener: EventListener | null = null;

  liveKitServerTypes: LiveKitServerTypes = {
    custom: {
      key: "custom",
      label: `${LANG_NAME}.serverTypeCustom`,
      details: `${LANG_NAME}.serverDetailsCustom`,
      urlRequired: true,
      usernameRequired: true,
      passwordRequired: true,
      tokenFunction: getAccessToken,
    },
    tavern: {
      key: "tavern",
      label: `${LANG_NAME}.serverTypeTavern`,
      details: `${LANG_NAME}.serverDetailsTavern`,
      url: "livekit.tavern.at",
      urlRequired: false,
      usernameRequired: false,
      passwordRequired: false,
      tokenFunction: getTavernAccessToken,
    },
  };

  defaultLiveKitServerType = this.liveKitServerTypes.custom;

  constructor(liveKitAvClient: LiveKitAVClient) {
    this.avMaster = liveKitAvClient.master;
    this.liveKitAvClient = liveKitAvClient;
    this.settings = liveKitAvClient.settings;

    this.render = foundry.utils.debounce(
      this.avMaster.render.bind(this.liveKitAvClient),
      2000,
    );
    // Debounce audio-source re-application so rapidly changing several audio
    // settings (e.g. via the reset button) only re-publishes the track once.
    this.scheduleAudioSourceChange = foundry.utils.debounce(() => {
      this.changeAudioSource(true).catch((error: unknown) => {
        log.error("Error changing audio source:", error);
      });
    }, 300);
    Hooks.callAll("liveKitClientAvailable", this);
  }

  /* -------------------------------------------- */
  /*  LiveKit Internal methods                */
  /* -------------------------------------------- */

  private enqueueAudioOperation(
    operation: () => Promise<void>,
  ): Promise<void> {
    const nextOperation = this.audioOperation.then(
      () => operation(),
      () => operation(),
    );
    this.audioOperation = nextOperation.catch(() => undefined);
    return nextOperation;
  }

  private enqueueVideoOperation(
    operation: () => Promise<void>,
  ): Promise<void> {
    const nextOperation = this.videoOperation.then(
      () => operation(),
      () => operation(),
    );
    this.videoOperation = nextOperation.catch(() => undefined);
    return nextOperation;
  }

  addAllParticipants(): void {
    if (!this.liveKitRoom) {
      log.warn(
        "Attempting to add participants before the LiveKit room is available",
      );
      return;
    }

    // Add our user to the participants list
    const userId = game.user?.id;
    if (userId) {
      this.liveKitParticipants.set(userId, this.liveKitRoom.localParticipant);
    }

    // Set up all other users
    this.liveKitRoom.remoteParticipants.forEach(
      (participant: RemoteParticipant) => {
        this.onParticipantConnected(participant);
      },
    );
  }

  addConnectionButtons(element: HTMLElement): void {
    // If useExternalAV is enabled, return
    if (this.useExternalAV) {
      return;
    }

    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className =
      "av-control inline-control toggle icon fa-solid fa-fw fa-toggle-off livekit-control connect hidden";
    connectButton.dataset.tooltip = "";
    connectButton.ariaLabel =
      game.i18n?.localize(`${LANG_NAME}.connect`) ?? "connect";

    const disconnectButton = document.createElement("button");
    disconnectButton.type = "button";
    disconnectButton.className =
      "av-control inline-control toggle icon fa-solid fa-fw fa-toggle-on livekit-control disconnect hidden";
    disconnectButton.dataset.tooltip = "";
    disconnectButton.ariaLabel =
      game.i18n?.localize(`${LANG_NAME}.disconnect`) ?? "disconnect";

    connectButton.addEventListener("click", () => {
      connectButton.classList.toggle("disabled", true);
      this.avMaster.connect().catch((error: unknown) => {
        log.error("Error connecting:", error);
      });
    });
    element.before(connectButton);

    disconnectButton.addEventListener("click", () => {
      disconnectButton.classList.toggle("disabled", true);
      this.avMaster
        .disconnect()
        .then(() => {
          this.render();
        })
        .catch((error: unknown) => {
          log.error("Error disconnecting:", error);
        });
    });
    element.before(disconnectButton);

    if (this.liveKitRoom?.state === ConnectionState.Connected) {
      disconnectButton.classList.toggle("hidden", false);
    } else {
      connectButton.classList.toggle("hidden", false);
    }
  }

  /**
   * Add a screen sharing button to the local user's camera controls.
   * @param {HTMLElement} element   The element to insert the button before
   */
  addScreenShareButton(element: HTMLElement): void {
    if (this.useExternalAV) {
      return;
    }

    const screenShareButton = document.createElement("button");
    screenShareButton.type = "button";
    screenShareButton.className =
      "av-control inline-control toggle icon fa-solid fa-fw fa-display livekit-control livekit-screen-share-control";
    screenShareButton.dataset.tooltip = "";

    screenShareButton.addEventListener("click", () => {
      this.shareScreen(!this.isScreenSharing).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Error sharing screen:", error);
        ui.notifications?.error(
          game.i18n?.format(`${LANG_NAME}.screenShareError`, { message }) ??
            `Unable to share screen: ${message}`,
        );
      });
    });

    element.before(screenShareButton);
    this.updateScreenShareButtons();
  }

  get isScreenSharing(): boolean {
    return this.screenTracks.some((track) => track instanceof LocalVideoTrack);
  }

  private updateScreenShareButtons(): void {
    const connected = this.liveKitRoom?.state === ConnectionState.Connected;
    const labelKey = this.isScreenSharing
      ? "stopScreenShare"
      : "startScreenShare";
    const label = game.i18n?.localize(`${LANG_NAME}.${labelKey}`) ?? labelKey;

    document
      .querySelectorAll<HTMLElement>(".livekit-screen-share-control")
      .forEach((button) => {
        button.classList.toggle("active", this.isScreenSharing);
        button.classList.toggle(
          "disabled",
          this.screenSharePending || !connected,
        );
        button.ariaLabel = label;
      });
  }

  /**
   * Add a noise cancellation model selector button to the user's camera control
   * bar. Clicking the button opens a small menu letting the user pick a noise
   * suppression model (RNNoise, Speex, or GTCRN) or turn it off ("None"). The
   * button is only added when the filters are supported by the current browser.
   * @param {HTMLElement} element   The element to insert the button before
   */
  addRnnoiseButton(element: HTMLElement): void {
    // If useExternalAV is enabled, return
    if (this.useExternalAV) {
      return;
    }

    // Don't add the button if the browser doesn't support the noise filter
    if (!isNoiseSuppressionSupported()) {
      return;
    }

    // Remove any stale menu left over from a previous render
    this.closeNoiseModelMenu();

    const rnnoiseButton = document.createElement("button");
    rnnoiseButton.type = "button";
    rnnoiseButton.className =
      "av-control inline-control toggle icon fa-solid fa-fw fa-wand-magic-sparkles livekit-control livekit-rnnoise-control";
    rnnoiseButton.dataset.tooltip = "";
    this.updateNoiseModelButton(rnnoiseButton);

    rnnoiseButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleNoiseModelMenu(rnnoiseButton);
    });
    element.before(rnnoiseButton);
  }

  /**
   * Update the noise model button's active state and tooltip to reflect the
   * current settings.
   * @param {HTMLElement} button   The noise model selector button
   */
  private updateNoiseModelButton(button: HTMLElement): void {
    const enabled =
      game.settings?.get(MODULE_NAME, "enhancedNoiseCancellation") ?? false;
    button.classList.toggle("active", enabled);

    const title =
      game.i18n?.localize(`${LANG_NAME}.enhancedNoiseCancellation`) ??
      "Noise Cancellation";

    if (enabled) {
      const model = toNoiseSuppressorModel(
        game.settings?.get(MODULE_NAME, "noiseSuppressionModel"),
      );
      button.ariaLabel = `${title}: ${this.getNoiseModelLabel(model)}`;
    } else {
      button.ariaLabel = `${title}: ${this.getNoiseModelLabel("none")}`;
    }
  }

  /**
   * Localize the label for a noise suppression model (or "none").
   */
  private getNoiseModelLabel(model: NoiseSuppressorModel | "none"): string {
    if (model === "none") {
      return (
        game.i18n?.localize(`${LANG_NAME}.noiseSuppressionModelNone`) ?? "None"
      );
    }
    const key = `${LANG_NAME}.noiseSuppressionModel${
      model.charAt(0).toUpperCase() + model.slice(1)
    }`;
    return game.i18n?.localize(key) ?? model;
  }

  /**
   * Toggle the noise model selection menu open or closed for the given button.
   */
  private toggleNoiseModelMenu(button: HTMLElement): void {
    if (this.noiseModelMenu) {
      this.closeNoiseModelMenu();
      return;
    }
    this.openNoiseModelMenu(button);
  }

  /**
   * Open a popup menu anchored to the given button. The menu lets the user pick
   * the active noise cancellation model (or "None"), toggle the audio
   * refinements (auto gain control, echo cancellation, noise gate), adjust the
   * noise gate threshold, and reset everything to defaults.
   */
  private openNoiseModelMenu(button: HTMLElement): void {
    this.closeNoiseModelMenu();

    const menu = document.createElement("div");
    menu.className = "livekit-noise-menu";
    document.body.append(menu);
    this.noiseModelMenu = menu;

    this.renderNoiseMenuContent(menu, button);
    this.positionNoiseMenu(menu, button);

    // Close the menu when clicking anywhere outside of it or the button
    this.noiseModelMenuDismiss = (dismissEvent: Event) => {
      const target = dismissEvent.target;
      if (
        target instanceof Node &&
        (menu.contains(target) || button.contains(target))
      ) {
        return;
      }
      this.closeNoiseModelMenu();
    };
    // Defer attaching so the opening click doesn't immediately dismiss it
    this.noiseModelMenuTimeout = window.setTimeout(() => {
      this.noiseModelMenuTimeout = null;
      if (this.noiseModelMenuDismiss) {
        document.addEventListener(
          "pointerdown",
          this.noiseModelMenuDismiss,
          true,
        );
      }
    }, 0);
  }

  /**
   * Position the menu just above the given button using fixed positioning so it
   * is not clipped by the camera view container.
   */
  private positionNoiseMenu(menu: HTMLElement, button: HTMLElement): void {
    const rect = button.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(rect.left).toString()}px`;
    menu.style.bottom = `${Math.round(
      window.innerHeight - rect.top + 4,
    ).toString()}px`;

    // Keep the menu within the viewport horizontally
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${Math.round(
        window.innerWidth - menuRect.width - 4,
      ).toString()}px`;
    }
  }

  /**
   * (Re)build the contents of the noise menu to reflect the current settings.
   * Rebuilding replaces all child nodes, so the event listeners attached to the
   * previous nodes are released for garbage collection.
   */
  private renderNoiseMenuContent(menu: HTMLElement, button: HTMLElement): void {
    menu.replaceChildren();

    const enabled =
      game.settings?.get(MODULE_NAME, "enhancedNoiseCancellation") ?? false;
    const currentModel: NoiseSuppressorModel | "none" = enabled
      ? toNoiseSuppressorModel(
          game.settings?.get(MODULE_NAME, "noiseSuppressionModel"),
        )
      : "none";
    const refinementsDisabled = currentModel === "none";

    // Refresh helper: rebuild + reposition + update the control-bar button
    const refresh = () => {
      if (this.noiseModelMenu === menu) {
        this.renderNoiseMenuContent(menu, button);
        this.positionNoiseMenu(menu, button);
      }
      this.updateNoiseModelButton(button);
    };

    // Header
    const header = document.createElement("div");
    header.className = "livekit-noise-menu-header";
    header.textContent =
      game.i18n?.localize(`${LANG_NAME}.noiseSuppressionModel`) ??
      "Noise Cancellation";
    menu.append(header);

    // Model options
    const models: (NoiseSuppressorModel | "none")[] = [
      "none",
      "speex",
      "rnnoise",
      "gtcrn",
    ];
    for (const option of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "livekit-noise-menu-item";
      item.classList.toggle("active", option === currentModel);

      const check = document.createElement("i");
      check.className = `fa-solid fa-fw ${
        option === currentModel ? "fa-check" : ""
      }`;
      item.append(check);

      const label = document.createElement("span");
      label.textContent = this.getNoiseModelLabel(option);
      item.append(label);

      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectNoiseModel(option)
          .then(refresh)
          .catch((error: unknown) => {
            log.error("Error selecting noise suppression model:", error);
          });
      });

      menu.append(item);
    }

    // Divider + refinements subheader
    const divider = document.createElement("div");
    divider.className = "livekit-noise-menu-divider";
    menu.append(divider);

    const subheader = document.createElement("div");
    subheader.className = "livekit-noise-menu-subheader";
    subheader.textContent =
      game.i18n?.localize(`${LANG_NAME}.noiseRefinements`) ?? "Refinements";
    menu.append(subheader);

    // Refinement toggles (disabled when no model is selected)
    const toggles: {
      key: "audioAutoGainControl" | "audioEchoCancellation" | "audioNoiseGate";
      defaultValue: boolean;
    }[] = [
      { key: "audioAutoGainControl", defaultValue: true },
      { key: "audioEchoCancellation", defaultValue: true },
      { key: "audioNoiseGate", defaultValue: false },
    ];

    for (const toggle of toggles) {
      const value =
        game.settings?.get(MODULE_NAME, toggle.key) ?? toggle.defaultValue;

      const item = document.createElement("button");
      item.type = "button";
      item.className = "livekit-noise-menu-item toggle";
      item.classList.toggle("active", value && !refinementsDisabled);
      item.classList.toggle("disabled", refinementsDisabled);
      item.disabled = refinementsDisabled;

      const check = document.createElement("i");
      check.className = `fa-solid fa-fw ${
        value ? "fa-square-check" : "fa-square"
      }`;
      item.append(check);

      const label = document.createElement("span");
      label.textContent =
        game.i18n?.localize(`${LANG_NAME}.${toggle.key}`) ?? toggle.key;
      item.append(label);

      if (!refinementsDisabled) {
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          game.settings
            ?.set(MODULE_NAME, toggle.key, !value)
            .then(refresh)
            .catch((error: unknown) => {
              log.error(`Error toggling ${toggle.key}:`, error);
            });
        });
      }

      menu.append(item);
    }

    // Noise gate threshold slider (disabled unless a model and the gate are on)
    const gateOn = game.settings?.get(MODULE_NAME, "audioNoiseGate") ?? false;
    const sliderDisabled = refinementsDisabled || !gateOn;
    const thresholdValue =
      game.settings?.get(MODULE_NAME, "audioNoiseGateThreshold") ?? -50;
    const thresholdName =
      game.i18n?.localize(`${LANG_NAME}.audioNoiseGateThreshold`) ??
      "Noise Gate Threshold (dB)";

    const sliderRow = document.createElement("div");
    sliderRow.className = "livekit-noise-menu-slider";
    sliderRow.classList.toggle("disabled", sliderDisabled);

    const sliderLabel = document.createElement("span");
    sliderLabel.className = "livekit-noise-menu-slider-label";
    sliderLabel.textContent = `${thresholdName}: ${thresholdValue.toString()}`;
    sliderRow.append(sliderLabel);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-80";
    slider.max = "0";
    slider.step = "1";
    slider.value = thresholdValue.toString();
    slider.disabled = sliderDisabled;
    slider.addEventListener("input", () => {
      sliderLabel.textContent = `${thresholdName}: ${slider.value}`;
    });
    slider.addEventListener("change", () => {
      game.settings
        ?.set(MODULE_NAME, "audioNoiseGateThreshold", Number(slider.value))
        .catch((error: unknown) => {
          log.error("Error setting audioNoiseGateThreshold:", error);
        });
    });
    // Keep the outside-click dismiss from firing while dragging the slider
    slider.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    sliderRow.append(slider);
    menu.append(sliderRow);

    // Divider + reset to defaults
    const divider2 = document.createElement("div");
    divider2.className = "livekit-noise-menu-divider";
    menu.append(divider2);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "livekit-noise-menu-item reset";
    const resetIcon = document.createElement("i");
    resetIcon.className = "fa-solid fa-fw fa-rotate-left";
    reset.append(resetIcon);
    const resetLabel = document.createElement("span");
    resetLabel.textContent =
      game.i18n?.localize(`${LANG_NAME}.noiseResetDefaults`) ??
      "Reset to defaults";
    reset.append(resetLabel);
    reset.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.resetNoiseSettings()
        .then(refresh)
        .catch((error: unknown) => {
          log.error("Error resetting noise settings:", error);
        });
    });
    menu.append(reset);
  }

  /**
   * Close and clean up the noise model selection menu if it is open. Removes the
   * outside-click listener, cancels the pending attach timeout, and detaches the
   * menu element so all of its child listeners can be garbage collected.
   */
  private closeNoiseModelMenu(): void {
    if (this.noiseModelMenuTimeout !== null) {
      window.clearTimeout(this.noiseModelMenuTimeout);
      this.noiseModelMenuTimeout = null;
    }
    if (this.noiseModelMenuDismiss) {
      document.removeEventListener(
        "pointerdown",
        this.noiseModelMenuDismiss,
        true,
      );
      this.noiseModelMenuDismiss = null;
    }
    if (this.noiseModelMenu) {
      this.noiseModelMenu.remove();
      this.noiseModelMenu = null;
    }
  }

  /**
   * Apply a noise model selection. Selecting "none" disables enhanced noise
   * cancellation; selecting a model enables it and sets the active model.
   */
  private async selectNoiseModel(
    model: NoiseSuppressorModel | "none",
  ): Promise<void> {
    if (model === "none") {
      await game.settings?.set(MODULE_NAME, "enhancedNoiseCancellation", false);
      return;
    }

    await game.settings?.set(MODULE_NAME, "noiseSuppressionModel", model);
    if (
      !(game.settings?.get(MODULE_NAME, "enhancedNoiseCancellation") ?? false)
    ) {
      await game.settings?.set(MODULE_NAME, "enhancedNoiseCancellation", true);
    }
  }

  /**
   * Reset all noise-related client settings to their defaults. This clears any
   * stale saved state (for example an old model that is no longer offered). The
   * settings' onChange handlers coalesce into a single debounced audio-source
   * change.
   */
  private async resetNoiseSettings(): Promise<void> {
    await game.settings?.set(MODULE_NAME, "enhancedNoiseCancellation", false);
    await game.settings?.set(MODULE_NAME, "noiseSuppressionModel", "gtcrn");
    await game.settings?.set(MODULE_NAME, "audioAutoGainControl", true);
    await game.settings?.set(MODULE_NAME, "audioEchoCancellation", true);
    await game.settings?.set(MODULE_NAME, "audioNoiseSuppression", true);
    await game.settings?.set(MODULE_NAME, "audioNoiseGate", false);
    await game.settings?.set(MODULE_NAME, "audioNoiseGateThreshold", -50);
  }

  addConnectionQualityIndicator(userId: string): void {
    if (!game.settings?.get(MODULE_NAME, "displayConnectionQuality")) {
      // Connection quality indicator is not enabled
      return;
    }

    // Get the user camera view and player name bar
    const userCameraView = document.querySelector(
      `.camera-view[data-user="${userId}"]`,
    );
    const userNameBar = userCameraView?.querySelector(".player-name");

    if (userCameraView?.querySelector(".connection-quality-indicator")) {
      // Connection quality indicator already exists
      return;
    }

    const connectionQualityIndicator = $(
      `<div class="connection-quality-indicator unknown" title="${
        game.i18n?.localize(
          `${LANG_NAME}.connectionQuality.${ConnectionQuality.Unknown}`,
        ) ?? "Connectin Quality Unknown"
      }"></div>`,
    );

    if (userNameBar instanceof Element) {
      $(userNameBar).after(connectionQualityIndicator);
    }

    this.setConnectionQualityIndicator(userId);
  }

  addLiveKitServerType(liveKitServerType: LiveKitServerType): boolean {
    if (!this.isLiveKitServerType(liveKitServerType)) {
      log.error(
        "Attempted to add a LiveKitServerType that does not meet the requirements:",
        liveKitServerType,
      );
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.liveKitServerTypes[liveKitServerType.key] !== undefined) {
      log.error(
        "Attempted to add a LiveKitServerType with a key that already exists:",
        liveKitServerType,
      );
      return false;
    }
    this.liveKitServerTypes[liveKitServerType.key] = liveKitServerType;
    return true;
  }

  async attachAudioTrack(
    userId: string,
    userAudioTrack: RemoteAudioTrack,
    audioElement: HTMLAudioElement,
  ): Promise<void> {
    const mediaStream =
      audioElement.srcObject instanceof MediaStream
        ? audioElement.srcObject
        : null;
    const isCurrentTrack = Boolean(
      userAudioTrack.attachedElements.includes(audioElement) &&
        mediaStream
          ?.getAudioTracks()
          .includes(userAudioTrack.mediaStreamTrack),
    );

    // Keep the selected output device synchronized even when the same track is
    // already attached and only the client's audio-sink setting changed.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (audioElement.sinkId === undefined) {
      if (!isCurrentTrack) {
        log.warn("Your web browser does not support output audio sink selection");
      }
    } else {
      const requestedSink = this.settings.get("client", "audioSink");
      if (audioElement.sinkId !== requestedSink) {
        // @ts-expect-error - setSinkId is currently an experimental method and not in the defined types
        await audioElement.setSinkId(requestedSink).catch((error: unknown) => {
          let message = error;
          if (error instanceof Error) {
            message = error.message;
          }
          log.error(
            "An error occurred when requesting the output audio device:",
            requestedSink,
            message,
          );
        });
      }
    }

    // The participant may unsubscribe or disconnect while setSinkId is
    // pending. Never attach playback to an element already removed by cleanup.
    if (
      !audioElement.isConnected ||
      !audioElement.closest("#livekit-remote-audio-container")
    ) {
      return;
    }

    if (!isCurrentTrack) {
      // Keep exactly one playback element per remote audio track.
      userAudioTrack.detach();
      userAudioTrack.attach(audioElement);
    } else if (audioElement.paused) {
      audioElement.play().catch((error: unknown) => {
        log.debug("Could not resume audio playback:", error);
      });
    }

    // Set the parameters
    let userVolume = this.settings.getUser(userId)?.volume;
    if (typeof userVolume === "undefined") {
      userVolume = 1.0;
    }
    audioElement.volume = userVolume;
    audioElement.muted = this.settings.get("client", "muteAll") === true;
  }

  attachVideoTrack(
    userVideoTrack: VideoTrack,
    videoElement: HTMLVideoElement,
  ): void {
    // Remove references to elements destroyed by a Foundry re-render, but keep
    // other connected views (for example, a dock and a popout) working.
    for (const attachedElement of [...userVideoTrack.attachedElements]) {
      if (!attachedElement.isConnected) {
        userVideoTrack.detach(attachedElement);
      }
    }

    videoElement.classList.toggle(
      "livekit-screen-share-video",
      userVideoTrack.source === Track.Source.ScreenShare,
    );

    // LiveKit intentionally repairs srcObject even when it already records the
    // element as attached. Always call attach: another video source may have
    // replaced this element's MediaStream track without updating that record.
    userVideoTrack.attach(videoElement);
  }

  changeAudioSource(forceStop = false): Promise<void> {
    return this.enqueueAudioOperation(() =>
      this.changeAudioSourceInternal(forceStop),
    );
  }

  private async changeAudioSourceInternal(forceStop: boolean): Promise<void> {
    // Force the stop of an existing track
    if (forceStop && this.audioTrack) {
      await this.liveKitRoom?.localParticipant.unpublishTrack(this.audioTrack);
      this.audioTrack.stop();
      this.audioTrack = null;
      game.user?.broadcastActivity({ av: { muted: true } });
    }

    if (
      !this.audioTrack ||
      this.settings.get("client", "audioSrc") === "disabled" ||
      !this.avMaster.canUserBroadcastAudio(game.user?.id ?? "")
    ) {
      if (this.audioTrack) {
        await this.liveKitRoom?.localParticipant.unpublishTrack(
          this.audioTrack,
        );
        this.audioTrack.stop();
        this.audioTrack = null;
        game.user?.broadcastActivity({ av: { muted: true } });
      } else {
        await this.initializeAudioTrack();
        const audioTrack = this.audioTrack as LocalAudioTrack | null;
        if (audioTrack) {
          await this.liveKitRoom?.localParticipant.publishTrack(
            audioTrack,
            this.trackPublishOptions,
          );
          if (this.audioBroadcastEnabled && audioTrack.isMuted) {
            await audioTrack.unmute();
          }
          game.user?.broadcastActivity({
            av: { muted: audioTrack.isMuted },
          });
          this.avMaster.render();
        } else {
          game.user?.broadcastActivity({ av: { muted: true } });
        }
      }
    } else {
      const audioParams = this.getAudioParams();
      if (audioParams) {
        await this.audioTrack.restartTrack(audioParams);
      }
    }
  }

  changeVideoSource(): Promise<void> {
    return this.enqueueVideoOperation(() => this.changeVideoSourceInternal());
  }

  private async changeVideoSourceInternal(): Promise<void> {
    const isScreenSharing = this.isScreenSharing;
    if (
      !this.videoTrack ||
      this.settings.get("client", "videoSrc") === "disabled" ||
      !this.avMaster.canUserBroadcastVideo(game.user?.id ?? "")
    ) {
      if (this.videoTrack) {
        if (isScreenSharing) {
          this.restoreCameraAfterScreenShare = false;
        }
        await this.liveKitRoom?.localParticipant.unpublishTrack(
          this.videoTrack,
        );
        this.videoTrack.detach();
        this.videoTrack.stop();
        this.videoTrack = null;
        game.user?.broadcastActivity({ av: { hidden: !isScreenSharing } });
      } else {
        await this.initializeVideoTrack();
        const videoTrack = this.videoTrack as LocalVideoTrack | null;
        if (videoTrack) {
          await this.liveKitRoom?.localParticipant.publishTrack(
            videoTrack,
            this.trackPublishOptions,
          );
          if (isScreenSharing) {
            this.restoreCameraAfterScreenShare =
              this.avMaster.canUserShareVideo(game.user?.id ?? "");
            if (!videoTrack.isMuted) {
              await videoTrack.mute();
            }
          }
          game.user?.broadcastActivity({
            av: { hidden: isScreenSharing ? false : videoTrack.isMuted },
          });
          this.renderAndReattachLocalVideo();
        } else {
          game.user?.broadcastActivity({ av: { hidden: !isScreenSharing } });
        }
      }
    } else {
      const videoParams = this.getVideoParams();
      if (videoParams) {
        await this.videoTrack.restartTrack(videoParams);
        if (isScreenSharing) {
          this.restoreCameraAfterScreenShare =
            this.avMaster.canUserShareVideo(game.user?.id ?? "");
          if (!this.videoTrack.isMuted) {
            await this.videoTrack.mute();
          }
        }
      }
    }
  }

  setVideoEnabledState(enable: boolean): Promise<void> {
    return this.enqueueVideoOperation(async () => {
      let videoTrack = this.videoTrack;
      if (enable && (!videoTrack || this.isTrackEnded(videoTrack))) {
        if (videoTrack) {
          await this.liveKitRoom?.localParticipant
            .unpublishTrack(videoTrack)
            .catch(() => undefined);
          videoTrack.detach();
          videoTrack.stop();
          this.videoTrack = null;
        }

        await this.initializeVideoTrack();
        videoTrack = this.videoTrack;
      }

      if (!videoTrack) {
        log.debug("setVideoEnabledState called but no video track is available");
        return;
      }

      const room = this.liveKitRoom;
      const isPublished = [
        ...(room?.localParticipant.videoTrackPublications.values() ?? []),
      ].some((publication) => publication.track === videoTrack);
      if (enable && room?.state === ConnectionState.Connected && !isPublished) {
        await room.localParticipant.publishTrack(
          videoTrack,
          this.trackPublishOptions,
        );
      }

      if (this.isScreenSharing) {
        // Store the latest user choice, but keep the camera muted until screen
        // sharing ends so it cannot replace the shared display on peers.
        this.restoreCameraAfterScreenShare = enable;
        if (!videoTrack.isMuted) {
          await videoTrack.mute();
        }
        this.avMaster.render();
        return;
      }

      if (!enable && !videoTrack.isMuted) {
        await videoTrack.mute();
      } else if (enable && videoTrack.isMuted) {
        await videoTrack.unmute();
      }
      game.user?.broadcastActivity({ av: { hidden: videoTrack.isMuted } });
      this.renderAndReattachLocalVideo();
    });
  }

  getAudioParams(): AudioCaptureOptions | false {
    // Determine whether the user can send audio
    const audioSrc = this.settings.get("client", "audioSrc");
    const canBroadcastAudio = this.avMaster.canUserBroadcastAudio(
      game.user?.id ?? "",
    );

    if (
      typeof audioSrc !== "string" ||
      audioSrc === "disabled" ||
      !canBroadcastAudio
    ) {
      return false;
    }

    const audioCaptureOptions: AudioCaptureOptions = {
      deviceId: { ideal: audioSrc },
      channelCount: { ideal: 1 },
    };

    // Set audio parameters for music streaming mode
    if (game.settings?.get(MODULE_NAME, "audioMusicMode")) {
      audioCaptureOptions.autoGainControl = false;
      audioCaptureOptions.echoCancellation = false;
      audioCaptureOptions.noiseSuppression = false;
      audioCaptureOptions.channelCount = { ideal: 2 };
    } else {
      // Apply user-configurable WebRTC audio processing constraints
      audioCaptureOptions.autoGainControl =
        game.settings?.get(MODULE_NAME, "audioAutoGainControl") ?? true;
      audioCaptureOptions.echoCancellation =
        game.settings?.get(MODULE_NAME, "audioEchoCancellation") ?? true;
      audioCaptureOptions.noiseSuppression =
        game.settings?.get(MODULE_NAME, "audioNoiseSuppression") ?? true;

      // When enhanced noise cancellation is enabled, disable the browser's
      // native noise suppression to avoid double-processing the audio. The
      // noise suppression processor itself is attached in initializeAudioTrack.
      if (
        (game.settings?.get(MODULE_NAME, "enhancedNoiseCancellation") ??
          false) &&
        isNoiseSuppressionSupported()
      ) {
        audioCaptureOptions.noiseSuppression = false;
      }
    }

    return audioCaptureOptions;
  }

  getParticipantFVTTUser(participant: Participant): User | undefined {
    try {
      const { fvttUserId } = JSON.parse(participant.metadata ?? "{}") as {
        fvttUserId?: string;
      };
      return fvttUserId ? game.users?.get(fvttUserId) : undefined;
    } catch (error) {
      log.warn("Invalid participant metadata:", participant.identity, error);
      return undefined;
    }
  }

  getParticipantUseExternalAV(participant: Participant): boolean {
    try {
      const { useExternalAV } = JSON.parse(participant.metadata ?? "{}") as {
        useExternalAV?: boolean;
      };
      return useExternalAV ?? false;
    } catch (error) {
      log.warn("Invalid participant metadata:", participant.identity, error);
      return false;
    }
  }

  getUserAudioTrack(
    userId: string | undefined,
  ): LocalAudioTrack | RemoteAudioTrack | null {
    let audioTrack: LocalAudioTrack | RemoteAudioTrack | null = null;

    // If the user ID is null, return a null track
    if (!userId) {
      return audioTrack;
    }

    this.liveKitParticipants
      .get(userId)
      ?.audioTrackPublications.forEach((publication) => {
        if (
          publication.kind === Track.Kind.Audio &&
          (publication.track instanceof LocalAudioTrack ||
            publication.track instanceof RemoteAudioTrack)
        ) {
          audioTrack = publication.track;
        }
      });
    return audioTrack;
  }

  getUserStatistics(userId: string): string {
    const participant = this.liveKitParticipants.get(userId);
    let totalBitrate = 0;
    if (!participant) {
      return "";
    }

    for (const t of participant.trackPublications.values()) {
      if (t.track) {
        totalBitrate += t.track.currentBitrate;
      }
    }
    let bitrate = "";
    if (totalBitrate > 0) {
      bitrate = `${Math.round(totalBitrate / 1024).toLocaleString()} kbps`;
    }

    return bitrate;
  }

  getAllUserStatistics(): Map<string, string> {
    const userStatistics = new Map<string, string>();
    this.liveKitParticipants.forEach((_participant, userId) => {
      userStatistics.set(userId, this.getUserStatistics(userId));
    });
    return userStatistics;
  }

  getUserVideoTrack(
    userId: string | undefined,
  ): LocalVideoTrack | RemoteVideoTrack | null {
    // If the user ID is null, return a null track
    if (!userId) {
      return null;
    }

    let cameraTrack: LocalVideoTrack | RemoteVideoTrack | null = null;
    const publications = this.liveKitParticipants.get(
      userId,
    )?.videoTrackPublications;

    if (!publications) {
      return null;
    }

    for (const publication of publications.values()) {
      const track = publication.track;
      if (
        publication.kind !== Track.Kind.Video ||
        publication.isMuted ||
        !(
          track instanceof LocalVideoTrack || track instanceof RemoteVideoTrack
        ) ||
        track.mediaStreamTrack.readyState !== "live"
      ) {
        continue;
      }

      if (publication.source === Track.Source.ScreenShare) {
        return track;
      }

      if (publication.source === Track.Source.Camera) {
        cameraTrack = track;
      }
    }

    return cameraTrack;
  }

  private getUserVideoElements(
    userId: string,
    root: ParentNode = document,
  ): HTMLVideoElement[] {
    const videoElements = new Set<HTMLVideoElement>();
    const selector = `.camera-view[data-user="${userId}"]`;
    const cameraViews = [...root.querySelectorAll(selector)];
    if (root instanceof Element && root.matches(selector)) {
      cameraViews.unshift(root);
    }

    for (const cameraView of cameraViews) {
      if (cameraView instanceof HTMLVideoElement) {
        videoElements.add(cameraView);
        continue;
      }

      cameraView
        .querySelectorAll<HTMLVideoElement>(
          "video.user-video, video.user-camera, video",
        )
        .forEach((videoElement) => videoElements.add(videoElement));
    }

    return [...videoElements];
  }

  reattachRemoteVideoForUser(
    userId: string,
    root: ParentNode = document,
  ): void {
    if (
      userId === game.user?.id ||
      this.isUserVideoBlocked(userId)
    ) {
      return;
    }

    const videoTrack = this.getUserVideoTrack(userId);
    if (!videoTrack) {
      return;
    }

    for (const videoElement of this.getUserVideoElements(userId, root)) {
      this.attachVideoTrack(videoTrack, videoElement);
    }
  }

  isUserVideoBlocked(userId: string): boolean {
    return this.settings.getUser(userId)?.blocked ?? false;
  }

  private reattachRemoteVideo(root: ParentNode = document): void {
    this.liveKitParticipants.forEach((_participant, userId) => {
      this.reattachRemoteVideoForUser(userId, root);
    });
  }

  private getLocalVideoElement(): HTMLVideoElement | null {
    const userId = game.user?.id;
    return userId ? (this.getUserVideoElements(userId)[0] ?? null) : null;
  }

  private reattachLocalVideo(): void {
    if (this.isScreenSharing || !this.videoTrack) {
      return;
    }

    const localVideoElement = this.getLocalVideoElement();
    if (localVideoElement) {
      this.attachVideoTrack(this.videoTrack, localVideoElement);
    }
  }

  private renderAndReattachLocalVideo(): void {
    this.avMaster.render();
    requestAnimationFrame(() => {
      this.reattachLocalVideo();
    });
  }

  private isTrackEnded(track: LocalTrack): boolean {
    return track.mediaStreamTrack.readyState === "ended";
  }

  private clearScreenTracks(): void {
    const screenTracks = this.screenTracks;
    this.screenTracks = [];

    for (const screenTrack of screenTracks) {
      screenTrack.detach();
      screenTrack.stop();
    }

    document
      .querySelectorAll<HTMLVideoElement>("video.livekit-screen-share-video")
      .forEach((videoElement) => {
        videoElement.classList.remove("livekit-screen-share-video");
      });
  }

  private getRemoteAudioContainer(): HTMLElement {
    const existingContainer = document.getElementById(
      "livekit-remote-audio-container",
    );
    if (existingContainer) {
      return existingContainer;
    }

    const container = document.createElement("div");
    container.id = "livekit-remote-audio-container";
    container.hidden = true;
    document.body.append(container);
    return container;
  }

  /**
   * Get the persistent playback element for a remote user's audio source.
   * Audio must not be owned by a camera view: Foundry removes that DOM when a
   * receiver hides a camera, but hiding video must not mute the user's audio.
   */
  getUserAudioElement(
    userId: string,
    audioType: Track.Source,
  ): HTMLAudioElement {
    const container = this.getRemoteAudioContainer();
    const audioElement = [
      ...container.querySelectorAll<HTMLAudioElement>(
        "audio[data-livekit-remote-audio]",
      ),
    ].find(
      (element) =>
        element.dataset.userId === userId &&
        element.dataset.trackSource === audioType,
    );
    if (audioElement) {
      return audioElement;
    }

    const newAudioElement = document.createElement("audio");
    newAudioElement.autoplay = true;
    newAudioElement.dataset.livekitRemoteAudio = "true";
    newAudioElement.dataset.userId = userId;
    newAudioElement.dataset.trackSource = audioType;
    newAudioElement.className = `user-${audioType}-audio`;
    container.append(newAudioElement);

    // Remove camera-adjacent elements from older versions. Their LiveKit track
    // attachment is reconciled immediately after this method returns.
    document
      .querySelectorAll<HTMLAudioElement>(
        `audio.user-${audioType}-audio[data-user-id="${userId}"]`,
      )
      .forEach((element) => {
        if (element !== newAudioElement) {
          element.pause();
          element.remove();
        }
      });

    return newAudioElement;
  }

  private clearRemoteAudioElements(): void {
    const container = document.getElementById(
      "livekit-remote-audio-container",
    );
    if (!container) {
      return;
    }

    container
      .querySelectorAll<HTMLAudioElement>("audio[data-livekit-remote-audio]")
      .forEach((audioElement) => {
        audioElement.pause();
        audioElement.srcObject = null;
      });
    container.remove();
  }

  private removeRemoteAudioElement(
    userId: string,
    audioType: Track.Source,
  ): void {
    const container = document.getElementById(
      "livekit-remote-audio-container",
    );
    if (!container) {
      return;
    }

    container
      .querySelectorAll<HTMLAudioElement>("audio[data-livekit-remote-audio]")
      .forEach((audioElement) => {
        if (
          audioElement.dataset.userId === userId &&
          audioElement.dataset.trackSource === audioType
        ) {
          audioElement.pause();
          audioElement.srcObject = null;
          audioElement.remove();
        }
      });
  }

  async initializeLocalTracks(): Promise<void> {
    await this.initializeAudioTrack();
    await this.initializeVideoTrack();
  }

  async initializeAudioTrack(): Promise<void> {
    // Make sure the track is initially unset
    this.audioTrack = null;

    // Get audio parameters
    const audioParams = this.getAudioParams();

    // Get the track if requested
    if (audioParams) {
      try {
        this.audioTrack = await createLocalAudioTrack(audioParams);
        await this.applyAudioProcessors();
      } catch (error: unknown) {
        let message = error;
        if (error instanceof Error) {
          message = error.message;
        }
        log.error("Unable to acquire local audio:", message);
      }
    }

    // Check that mute/hidden/broadcast is toggled properly for the track
    if (
      this.audioTrack &&
      !(
        this.liveKitAvClient.isVoiceAlways &&
        this.avMaster.canUserShareAudio(game.user?.id ?? "")
      )
    ) {
      await this.audioTrack.mute();
    }
  }

  /**
   * Lazily create (and reuse) a 48kHz AudioContext used by the client-side
   * audio processors. RNNoise requires a 48kHz sample rate; the other noise
   * suppression models and the noise gate resample internally, so a single
   * 48kHz context works for all of them. It is intentionally kept alive between
   * tracks and is not closed by the processors themselves.
   */
  private getAudioProcessorContext(): AudioContext {
    if (
      !this.audioProcessorContext ||
      this.audioProcessorContext.state === "closed"
    ) {
      this.audioProcessorContext = new AudioContext({
        sampleRate: NOISE_SUPPRESSION_SAMPLE_RATE,
      });
    }
    return this.audioProcessorContext;
  }

  /**
   * Attach a client-side audio TrackProcessor to the current local audio track.
   *
   * LiveKit allows a single processor per track, so the enhanced noise
   * suppression filter (RNNoise, Speex, or GTCRN) takes precedence; when it is
   * disabled, the standalone noise gate is used instead. Both are skipped while
   * Music Mode is active. LiveKit requires an AudioContext to be set on the
   * track before a processor can be attached, so we provide our own 48kHz
   * context here.
   */
  async applyAudioProcessors(): Promise<void> {
    if (!this.audioTrack) {
      return;
    }

    if (game.settings?.get(MODULE_NAME, "audioMusicMode") ?? false) {
      return;
    }

    if (!isNoiseSuppressionSupported()) {
      return;
    }

    const noiseCancellationEnabled =
      game.settings?.get(MODULE_NAME, "enhancedNoiseCancellation") ?? false;
    const noiseGateEnabled =
      game.settings?.get(MODULE_NAME, "audioNoiseGate") ?? false;
    const gateThreshold =
      game.settings?.get(MODULE_NAME, "audioNoiseGateThreshold") ?? -50;

    try {
      if (noiseCancellationEnabled) {
        const model = toNoiseSuppressorModel(
          game.settings?.get(MODULE_NAME, "noiseSuppressionModel"),
        );
        // When the noise gate is also enabled, chain it before the model so
        // quiet background noise is gated out prior to denoising.
        const gate =
          noiseGateEnabled && isNoiseGateSupported() ? gateThreshold : undefined;
        this.audioTrack.setAudioContext(this.getAudioProcessorContext());
        await this.audioTrack.setProcessor(
          new NoiseSuppressorFilter(model, gate),
        );
        log.info(
          `Noise suppression enabled (model: ${model}${
            gate !== undefined ? " + noise gate" : ""
          })`,
        );
      } else if (noiseGateEnabled && isNoiseGateSupported()) {
        this.audioTrack.setAudioContext(this.getAudioProcessorContext());
        await this.audioTrack.setProcessor(new NoiseGateFilter(gateThreshold));
        log.info("Noise gate processor applied to local audio track");
      }
    } catch (error: unknown) {
      log.error("Error applying audio processor:", error);
    }
  }

  async initializeVideoTrack(): Promise<void> {
    // Make sure the track is initially unset
    this.videoTrack = null;

    // Get video parameters
    const videoParams = this.getVideoParams();

    // Get the track if requested
    if (videoParams) {
      try {
        this.videoTrack = await createLocalVideoTrack(videoParams);
      } catch (error: unknown) {
        let message = error;
        if (error instanceof Error) {
          message = error.message;
        }
        log.error("Unable to acquire local video:", message);
      }
    }

    // Check that mute/hidden/broadcast is toggled properly for the track
    if (
      this.videoTrack &&
      !this.avMaster.canUserShareVideo(game.user?.id ?? "")
    ) {
      await this.videoTrack.mute();
    }
  }

  initializeRoom(): void {
    // set the LiveKit publish defaults
    const liveKitPublishDefaults = this.trackPublishOptions;

    // Set the livekit room options
    const liveKitRoomOptions: RoomOptions = {
      adaptiveStream: liveKitPublishDefaults.simulcast,
      dynacast: liveKitPublishDefaults.simulcast,
      publishDefaults: liveKitPublishDefaults,
    };

    // Create and configure the room
    this.liveKitRoom = new Room(liveKitRoomOptions);

    // Set up room callbacks
    this.setRoomCallbacks();
  }

  isLiveKitServerType(
    liveKitServerType: LiveKitServerType,
  ): liveKitServerType is LiveKitServerType {
    if (
      typeof liveKitServerType.key !== "string" ||
      typeof liveKitServerType.label !== "string" ||
      typeof liveKitServerType.urlRequired !== "boolean" ||
      typeof liveKitServerType.usernameRequired !== "boolean" ||
      typeof liveKitServerType.passwordRequired !== "boolean" ||
      !(liveKitServerType.tokenFunction instanceof Function)
    ) {
      return false;
    }
    return true;
  }

  isUserExternal(userId: string): boolean {
    // TODO: Implement this when adding external user support
    log.debug("isUserExternal not yet implemented; userId:", userId);
    return false;
  }

  onAudioPlaybackStatusChanged(canPlayback: boolean): void {
    if (!canPlayback) {
      log.warn("Cannot play audio/video, waiting for user interaction");
      this.windowClickListener =
        this.windowClickListener ?? this.onWindowClick.bind(this);
      window.addEventListener("click", this.windowClickListener);
    }
  }

  async onConnected(): Promise<void> {
    log.debug("Client connected");

    // A network-forced disconnect can stop local MediaStreamTracks even when
    // a deliberate disconnect preserves them. Never republish ended tracks.
    if (this.audioTrack?.mediaStreamTrack.readyState === "ended") {
      this.audioTrack.detach();
      await this.initializeAudioTrack();
    }
    if (this.videoTrack?.mediaStreamTrack.readyState === "ended") {
      this.videoTrack.detach();
      await this.initializeVideoTrack();
    }

    // Set up local participant callbacks
    this.setLocalParticipantCallbacks();

    // Add users to participants list
    this.addAllParticipants();

    // Set connection button state
    this.setConnectionButtons(true);

    // Publish local tracks
    if (this.audioTrack) {
      await this.liveKitRoom?.localParticipant.publishTrack(
        this.audioTrack,
        this.trackPublishOptions,
      );
    }
    if (this.videoTrack) {
      await this.liveKitRoom?.localParticipant.publishTrack(
        this.videoTrack,
        this.trackPublishOptions,
      );
    }
    this.updateScreenShareButtons();
  }

  onConnectionQualityChanged(quality: string, participant: Participant) {
    log.debug("onConnectionQualityChanged:", quality, participant);

    if (!game.settings?.get(MODULE_NAME, "displayConnectionQuality")) {
      // Connection quality indicator is not enabled
      return;
    }

    const fvttUserId = this.getParticipantFVTTUser(participant)?.id;

    if (!fvttUserId) {
      log.warn(
        "Quality changed participant",
        participant,
        "is not an FVTT user",
      );
      return;
    }

    this.setConnectionQualityIndicator(fvttUserId, quality);
  }

  onDisconnected(reason?: DisconnectReason): void {
    log.debug("Client disconnected", { reason });
    let disconnectWarning =
      game.i18n?.localize(`${LANG_NAME}.onDisconnected`) ?? "onDisconnected";
    if (reason) {
      disconnectWarning += `: ${DisconnectReason[reason]}`;
    }
    ui.notifications?.warn(disconnectWarning);

    // Clear the participant map
    this.liveKitParticipants.clear();
    this.clearScreenTracks();
    this.clearRemoteAudioElements();
    if (
      this.restoreCameraAfterScreenShare &&
      this.videoTrack?.mediaStreamTrack.readyState === "live" &&
      this.videoTrack.isMuted
    ) {
      this.videoTrack.unmute().catch((error: unknown) => {
        log.debug("Could not restore camera after disconnect:", error);
      });
    }
    this.restoreCameraAfterScreenShare = false;
    this.screenSharePending = false;

    // Set connection buttons state
    this.setConnectionButtons(false);

    this.connectionState = ConnectionState.Disconnected;
    this.updateScreenShareButtons();

    // TODO: Add some incremental back-off reconnect logic here
  }

  onGetUserContextOptions(
    _playersApp: foundry.applications.ui.Players,
    contextOptions: foundry.applications.ux.ContextMenu.Entry<HTMLElement>[],
  ): void {
    // Don't add breakout options if AV is disabled
    if (
      this.settings.get("world", "mode") ===
      foundry.av.AVSettings.AV_MODES.DISABLED
    ) {
      return;
    }

    addContextOptions(contextOptions, this);
  }

  onIsSpeakingChanged(userId: string | undefined, speaking: boolean): void {
    if (userId) {
      // @ts-expect-error - ui.webrtc.setUserIsSpeaking is not in foundry-vtt-types yet
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ui.webrtc?.setUserIsSpeaking(userId, speaking);
    }
  }

  onParticipantConnected(participant: RemoteParticipant): void {
    log.debug("onParticipantConnected:", participant);

    const fvttUser = this.getParticipantFVTTUser(participant);

    if (!fvttUser?.id) {
      log.error(
        "Joining participant",
        participant,
        "is not an FVTT user; cannot display them",
      );
      return;
    }

    if (!fvttUser.active) {
      // Force the user to be active. If they are signing in to meeting, they should be online.
      log.warn(
        "Joining user",
        fvttUser.id,
        "is not listed as active. Setting to active.",
      );
      fvttUser.active = true;
      ui.players?.render().catch((error: unknown) => {
        log.error("Error rendering players view:", error);
      });
    }

    // Save the participant to the ID mapping
    this.liveKitParticipants.set(fvttUser.id, participant);

    // Clear breakout room cache if user is joining the main conference
    if (!this.breakoutRoom) {
      this.settings.set(
        "client",
        `users.${fvttUser.id}.liveKitBreakoutRoom`,
        "",
      );
    }

    // Set up remote participant callbacks
    this.setRemoteParticipantCallbacks(participant);

    // Call a debounced render
    this.render();
  }

  onParticipantDisconnected(participant: RemoteParticipant): void {
    log.debug("onParticipantDisconnected:", participant);

    // Remove the participant from the ID mapping
    const fvttUserId = this.getParticipantFVTTUser(participant)?.id;

    if (!fvttUserId) {
      log.warn("Leaving participant", participant, "is not an FVTT user");
      return;
    }

    // A delayed disconnect from an old LiveKit participant must not remove a
    // newer participant that has already reconnected for the same Foundry user.
    if (this.liveKitParticipants.get(fvttUserId) === participant) {
      this.liveKitParticipants.delete(fvttUserId);
      requestAnimationFrame(() => {
        this.reattachRemoteAudio();
      });
    }

    // Clear breakout room cache if user is leaving a breakout room
    if (
      this.settings.get("client", `users.${fvttUserId}.liveKitBreakoutRoom`) ===
        this.liveKitAvClient.room &&
      this.liveKitAvClient.room === this.breakoutRoom
    ) {
      this.settings.set(
        "client",
        `users.${fvttUserId}.liveKitBreakoutRoom`,
        "",
      );
    }

    // Call a debounced render
    this.render();
  }

  onReconnected(): void {
    log.info("Reconnect issued");
    this.addAllParticipants();
    this.reattachRemoteAudio();
    this.reattachRemoteVideo();
    // Re-render just in case users changed
    this.render();
  }

  onReconnecting(): void {
    log.warn("Reconnecting to room");
    ui.notifications?.warn(
      game.i18n?.localize("WEBRTC.ConnectionLostWarning") ??
        "ConnectionLostWarning",
    );
  }

  onSocketEvent(message: SocketMessage, userId: string): void {
    log.debug("Socket event:", message, "from:", userId);
    switch (message.action) {
      case "breakout":
        // Allow only GMs to issue breakout requests. Ignore requests that aren't for us.
        if (
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          game.users?.get(userId)?.isGM &&
          (!message.userId || message.userId === game.user.id)
        ) {
          breakout(message.breakoutRoom, this);
        }
        break;
      case "connect":
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (game.users?.get(userId)?.isGM) {
          this.avMaster.connect().catch((error: unknown) => {
            log.error("Error connecting:", error);
          });
        } else {
          log.warn("Connect socket event from non-GM user; ignoring");
        }
        break;
      case "disconnect":
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (game.users?.get(userId)?.isGM) {
          this.avMaster
            .disconnect()
            .then(() => {
              this.render();
            })
            .catch((error: unknown) => {
              log.error("Error disconnecting:", error);
            });
        } else {
          log.warn("Disconnect socket event from non-GM user; ignoring");
        }
        break;
      case "render":
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (game.users?.get(userId)?.isGM) {
          this.render();
        } else {
          log.warn("Render socket event from non-GM user; ignoring");
        }
        break;
      default:
        log.warn("Unknown socket event:", message);
    }
  }

  onTrackMuteChanged(
    publication: TrackPublication,
    participant: Participant,
  ): void {
    log.debug("onTrackMuteChanged:", publication, participant);

    // Local participant
    if (participant === this.liveKitRoom?.localParticipant) {
      log.debug("Local", publication.kind, "track muted:", publication.isMuted);
      return;
    }

    // Remote participant
    const fvttUserId = this.getParticipantFVTTUser(participant)?.id;
    const useExternalAV = this.getParticipantUseExternalAV(participant);

    if (!fvttUserId) {
      log.warn("Mute change participant", participant, "is not an FVTT user");
      return;
    }

    if (publication.kind === Track.Kind.Video) {
      // Camera and screen-share publications represent one Foundry video tile.
      // Re-select the best usable source instead of applying the state of the
      // last publication event to the whole user.
      const isReceiverBlocked = this.isUserVideoBlocked(fvttUserId);
      if (!isReceiverBlocked) {
        this.reattachRemoteVideoForUser(fvttUserId);
        debounceRefreshView(fvttUserId);
      }
      const isVideoHidden = this.getUserVideoTrack(fvttUserId) === null;

      if (useExternalAV) {
        this.avMaster.settings.handleUserActivity(fvttUserId, {
          hidden: isVideoHidden,
        });
      } else {
        const hiddenIndicator = document
          .querySelector(`.camera-view[data-user="${fvttUserId}"]`)
          ?.querySelector(".status-remote-hidden");
        hiddenIndicator?.classList.toggle("hidden", !isVideoHidden);
      }
      return;
    }

    if (useExternalAV) {
      if (publication.kind === Track.Kind.Audio) {
        this.avMaster.settings.handleUserActivity(fvttUserId, {
          muted: publication.isMuted,
        });
      }
    } else {
      const userCameraView = document.querySelector(
        `.camera-view[data-user="${fvttUserId}"]`,
      );
      if (userCameraView) {
        let uiIndicator;
        if (publication.kind === Track.Kind.Audio) {
          uiIndicator = userCameraView.querySelector(".status-remote-muted");
        }

        if (uiIndicator) {
          uiIndicator.classList.toggle("hidden", !publication.isMuted);
        }
      }
    }
  }

  onRenderCameraViews(
    _cameraviews: foundry.applications.apps.av.CameraViews,
    html: HTMLElement,
  ): void {
    // Re-attach remote audio after every camera view render. Camera views can
    // be rebuilt or reparented by Foundry itself or by third-party UI modules
    // (e.g. Carolingian UI minimizing/moving the dock), which destroys the
    // dynamically-created <audio> elements. Without this, a participant's audio
    // goes silent after such a render because the track stays attached to an
    // orphaned element that is no longer in the document.
    this.reattachRemoteAudio();
    this.reattachRemoteVideo(html);
    this.reattachLocalVideo();
    requestAnimationFrame(() => {
      this.reattachRemoteAudio();
      this.reattachRemoteVideo();
      this.reattachLocalVideo();
    });

    html
      .querySelectorAll<HTMLElement>(".webrtc-volume-slider")
      .forEach((volumeSlider) => {
        if (volumeSlider.dataset.livekitVolumeBound) {
          return;
        }
        volumeSlider.dataset.livekitVolumeBound = "true";
        volumeSlider.addEventListener(
          "change",
          this.onVolumeChange.bind(this),
        );
      });

    const userId = game.user?.id;
    if (!userId) {
      log.error("No user ID found; cannot render camera views");
      return;
    }
    const cameraBox = html.querySelector(
      `[data-user="${userId}"].user-controls`,
    );
    // Look for existing connection buttons
    if (cameraBox?.querySelector(".livekit-control")) {
      return;
    }
    const element = cameraBox?.querySelector('[data-action="configure"]');
    if (!(element instanceof HTMLElement)) {
      log.warn("Can't find CameraView configure element", element);
      return;
    }
    this.addConnectionButtons(element);
    this.addRnnoiseButton(element);
    this.addScreenShareButton(element);
  }

  /**
   * Ensure every subscribed remote audio track is attached to a live audio
   * element in the current DOM. If a track's attached element was destroyed by
   * a camera-view re-render (or the element still exists but was paused by a DOM
   * move), this recreates/re-attaches the element or resumes playback. This
   * keeps participant audio playing when UI modules minimize, move, or rebuild
   * the camera dock.
   */
  reattachRemoteAudio(): void {
    const localUserId = game.user?.id;
    const activeAudioElements = new Set<HTMLAudioElement>();

    this.liveKitParticipants.forEach((participant, userId) => {
      // The local participant has no remote audio to play back
      if (userId === localUserId) {
        return;
      }

      participant.audioTrackPublications.forEach((publication) => {
        const track = publication.track;
        if (!(track instanceof RemoteAudioTrack)) {
          return;
        }

        const audioElement = this.getUserAudioElement(
          userId,
          publication.source,
        );
        activeAudioElements.add(audioElement);

        this.attachAudioTrack(userId, track, audioElement).catch(
          (error: unknown) => {
            log.error("Error re-attaching audio track:", error);
          },
        );
      });
    });

    const container = document.getElementById(
      "livekit-remote-audio-container",
    );
    container
      ?.querySelectorAll<HTMLAudioElement>("audio[data-livekit-remote-audio]")
      .forEach((audioElement) => {
        if (!activeAudioElements.has(audioElement)) {
          audioElement.pause();
          audioElement.srcObject = null;
          audioElement.remove();
        }
      });
  }

  onTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    log.debug("onTrackSubscribed:", track, publication, participant);
    const fvttUserId = this.getParticipantFVTTUser(participant)?.id;

    if (!fvttUserId) {
      log.warn(
        "Track subscribed participant",
        participant,
        "is not an FVTT user",
      );
      return;
    }

    if (track instanceof RemoteAudioTrack) {
      const audioElement = this.getUserAudioElement(
        fvttUserId,
        publication.source,
      );
      this.attachAudioTrack(fvttUserId, track, audioElement).catch(
        (error: unknown) => {
          log.error("Error attaching audio track:", error);
        },
      );
      return;
    }

    const videoElement = this.getUserVideoElements(fvttUserId).at(0);

    if (!videoElement) {
      log.debug(
        "videoElement not yet ready for",
        fvttUserId,
        "; skipping publication",
        publication,
      );
      if (!this.isUserVideoBlocked(fvttUserId)) {
        debounceRefreshView(fvttUserId);
      }
      return;
    }

    if (track instanceof RemoteVideoTrack) {
      // Publication events can arrive camera-last or screen-last. Always attach
      // the source selected by policy (live screen share first, then camera),
      // not simply whichever subscription event arrived most recently.
      this.reattachRemoteVideoForUser(fvttUserId);
    } else {
      log.warn("Unknown track type subscribed from publication", publication);
    }

    if (!this.isUserVideoBlocked(fvttUserId)) {
      debounceRefreshView(fvttUserId);
    }
  }

  onTrackUnSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    log.debug("onTrackUnSubscribed:", track, publication, participant);
    track.detach();

    if (track instanceof RemoteAudioTrack) {
      const fvttUserId = this.getParticipantFVTTUser(participant)?.id;
      if (
        fvttUserId &&
        this.liveKitParticipants.get(fvttUserId) === participant
      ) {
        this.removeRemoteAudioElement(fvttUserId, publication.source);
      }
      return;
    }

    if (track instanceof RemoteVideoTrack) {
      const fvttUserId = this.getParticipantFVTTUser(participant)?.id;
      if (fvttUserId && !this.isUserVideoBlocked(fvttUserId)) {
        // A screen-share track and camera track use the same Foundry video
        // element. Refresh after removing the screen track so setUserVideo()
        // attaches the participant's still-published camera fallback.
        debounceRefreshView(fvttUserId);
      }
    }
  }

  /**
   * Change volume control for a stream
   * @param {Event} event   The originating change event from interaction with the range input
   */
  onVolumeChange(event: Event): void {
    const input = event.currentTarget;
    if (
      !(input instanceof foundry.applications.elements.HTMLRangePickerElement)
    ) {
      log.warn(
        "Volume change event did not originate from a range picker element",
      );
      return;
    }
    const box = input.closest(".camera-view");
    const volume = foundry.audio.AudioHelper.inputToVolume(input.value);
    if (!(box instanceof HTMLElement)) {
      log.warn("Volume change event did not originate from a camera view box");
      return;
    }
    const userId = box.dataset.user;
    document
      .getElementById("livekit-remote-audio-container")
      ?.querySelectorAll<HTMLAudioElement>("audio[data-livekit-remote-audio]")
      .forEach((audioElement) => {
        if (audioElement.dataset.userId === userId) {
          audioElement.volume = volume;
        }
      });

    // HACK: Needed to fix a bug in FVTT v13
    if (userId) {
      this.settings.set("client", `users.${userId}.volume`, volume);
    }
  }

  onWindowClick(): void {
    if (this.windowClickListener) {
      window.removeEventListener("click", this.windowClickListener);
      this.render();
    }
  }

  getVideoParams(): VideoCaptureOptions | false {
    // Configure whether the user can send video
    const videoSrc = this.settings.get("client", "videoSrc");
    const canBroadcastVideo = this.avMaster.canUserBroadcastVideo(
      game.user?.id ?? "",
    );

    // Set resolution higher if simulcast is enabled
    let videoResolution = VideoPresets43.h180.resolution;
    if (this.trackPublishOptions.simulcast) {
      videoResolution = VideoPresets43.h720.resolution;
    }

    return typeof videoSrc === "string" &&
      videoSrc !== "disabled" &&
      canBroadcastVideo
      ? {
          deviceId: { ideal: videoSrc },
          resolution: videoResolution,
        }
      : false;
  }

  async sendJoinMessage(liveKitServer: string, accessToken: string) {
    // Create the url for user to join the external LiveKit web client
    const params = new URLSearchParams({
      liveKitUrl: `wss://${liveKitServer}`,
      token: accessToken,
    });
    const url = `https://meet.livekit.io/custom?${params.toString()}`;

    await foundry.applications.api.DialogV2.confirm({
      window: { title: `${LANG_NAME}.externalAVJoinTitle` },
      content: `<p>${
        game.i18n?.localize(`${LANG_NAME}.externalAVJoinMessage`) ??
        "externalAVJoinMessage"
      }</p>`,
      yes: {
        label: `${LANG_NAME}.externalAVJoinButton`,
        icon: "fa-solid fa-check",
        callback: () => window.open(url),
      },
      no: {
        label: `${LANG_NAME}.externalAVIgnoreButton`,
        icon: "fa-solid fa-xmark",
        callback: () => {
          log.info("Ignoring external LiveKit join request");
        },
      },
    });
  }

  setAudioEnabledState(enable: boolean): Promise<void> {
    return this.enqueueAudioOperation(async () => {
      let audioTrack = this.audioTrack;
      if (enable && (!audioTrack || this.isTrackEnded(audioTrack))) {
        if (audioTrack) {
          await this.liveKitRoom?.localParticipant
            .unpublishTrack(audioTrack)
            .catch(() => undefined);
          audioTrack.detach();
          audioTrack.stop();
          this.audioTrack = null;
        }

        await this.initializeAudioTrack();
        audioTrack = this.audioTrack;
      }

      if (!audioTrack) {
        log.debug("setAudioEnabledState called but no audio track available");
        return;
      }

      const room = this.liveKitRoom;
      const isPublished = [
        ...(room?.localParticipant.audioTrackPublications.values() ?? []),
      ].some((publication) => publication.track === audioTrack);
      if (enable && room?.state === ConnectionState.Connected && !isPublished) {
        await room.localParticipant.publishTrack(
          audioTrack,
          this.trackPublishOptions,
        );
      }

      if (!enable && !audioTrack.isMuted) {
        log.debug("Muting audio track", audioTrack);
        await audioTrack.mute();
      } else if (enable && audioTrack.isMuted) {
        log.debug("Un-muting audio track", audioTrack);
        await audioTrack.unmute();
      }
      game.user?.broadcastActivity({ av: { muted: audioTrack.isMuted } });
      this.avMaster.render();
    });
  }

  setConnectionButtons(connected: boolean): void {
    const userCameraView = document.querySelector(
      `.camera-view[data-user="${game.user?.id ?? ""}"]`,
    );

    if (userCameraView) {
      const connectButton = userCameraView.querySelector(
        ".livekit-control.connect",
      );
      const disconnectButton = userCameraView.querySelector(
        ".livekit-control.disconnect",
      );

      connectButton?.classList.toggle("hidden", connected);
      connectButton?.classList.toggle("disabled", false);
      disconnectButton?.classList.toggle("hidden", !connected);
      disconnectButton?.classList.toggle("disabled", false);
    }
    this.updateScreenShareButtons();
  }

  setConnectionQualityIndicator(userId: string, quality?: string): void {
    // Get the user camera view and connection quality indicator
    const userCameraView = document.querySelector(
      `.camera-view[data-user="${userId}"]`,
    );
    const connectionQualityIndicator = userCameraView?.querySelector(
      ".connection-quality-indicator",
    );

    quality ??=
      this.liveKitParticipants.get(userId)?.connectionQuality ??
      ConnectionQuality.Unknown;

    if (connectionQualityIndicator instanceof HTMLDivElement) {
      // Remove all existing quality classes
      connectionQualityIndicator.classList.remove(
        ...Object.values(ConnectionQuality),
      );

      // Add the correct quality class
      connectionQualityIndicator.classList.add(quality);

      // Set the hover title
      connectionQualityIndicator.title =
        game.i18n?.localize(`${LANG_NAME}.connectionQuality.${quality}`) ??
        quality;
    }
  }

  setLocalParticipantCallbacks(): void {
    const participant = this.liveKitRoom?.localParticipant;
    if (!participant || this.participantCallbacksConfigured.has(participant)) {
      return;
    }
    this.participantCallbacksConfigured.add(participant);

    participant
      .on(
        ParticipantEvent.IsSpeakingChanged,
        this.onIsSpeakingChanged.bind(this, game.user?.id),
      )
      .on(ParticipantEvent.ParticipantMetadataChanged, (...args) => {
        log.debug("Local ParticipantEvent ParticipantMetadataChanged:", args);
      })
      .on(ParticipantEvent.TrackPublished, (...args) => {
        log.debug("Local ParticipantEvent TrackPublished:", args);
      })
      .on(ParticipantEvent.TrackSubscriptionStatusChanged, (...args) => {
        log.debug(
          "Local ParticipantEvent TrackSubscriptionStatusChanged:",
          args,
        );
      });
  }

  setRemoteParticipantCallbacks(participant: RemoteParticipant): void {
    if (this.participantCallbacksConfigured.has(participant)) {
      return;
    }

    const fvttUserId = this.getParticipantFVTTUser(participant)?.id;

    if (!fvttUserId) {
      log.warn(
        "Participant",
        participant,
        "is not an FVTT user; skipping setRemoteParticipantCallbacks",
      );
      return;
    }

    this.participantCallbacksConfigured.add(participant);

    participant
      .on(
        ParticipantEvent.IsSpeakingChanged,
        this.onIsSpeakingChanged.bind(this, fvttUserId),
      )
      .on(ParticipantEvent.ParticipantMetadataChanged, (...args) => {
        log.debug("Remote ParticipantEvent ParticipantMetadataChanged:", args);
      });
  }

  setRoomCallbacks(): void {
    if (!this.liveKitRoom) {
      log.warn(
        "Attempted to set up room callbacks before the LiveKit room is ready",
      );
      return;
    }

    // Set up event callbacks
    this.liveKitRoom
      .on(
        RoomEvent.AudioPlaybackStatusChanged,
        this.onAudioPlaybackStatusChanged.bind(this),
      )
      .on(
        RoomEvent.ParticipantConnected,
        this.onParticipantConnected.bind(this),
      )
      .on(
        RoomEvent.ParticipantDisconnected,
        this.onParticipantDisconnected.bind(this),
      )
      .on(RoomEvent.TrackSubscribed, this.onTrackSubscribed.bind(this))
      .on(RoomEvent.TrackSubscriptionFailed, (...args) => {
        log.error("RoomEvent TrackSubscriptionFailed:", args);
      })
      .on(RoomEvent.TrackUnpublished, (...args) => {
        log.debug("RoomEvent TrackUnpublished:", args);
      })
      .on(RoomEvent.TrackUnsubscribed, this.onTrackUnSubscribed.bind(this))
      .on(RoomEvent.LocalTrackUnpublished, (...args) => {
        log.debug("RoomEvent LocalTrackUnpublished:", args);
      })
      .on(
        RoomEvent.ConnectionQualityChanged,
        this.onConnectionQualityChanged.bind(this),
      )
      .on(RoomEvent.Disconnected, this.onDisconnected.bind(this))
      .on(RoomEvent.Reconnecting, this.onReconnecting.bind(this))
      .on(RoomEvent.TrackMuted, this.onTrackMuteChanged.bind(this))
      .on(RoomEvent.TrackUnmuted, this.onTrackMuteChanged.bind(this))
      .on(RoomEvent.ParticipantMetadataChanged, (...args) => {
        log.debug("RoomEvent ParticipantMetadataChanged:", args);
      })
      .on(RoomEvent.RoomMetadataChanged, (...args) => {
        log.debug("RoomEvent RoomMetadataChanged:", args);
      })
      .on(RoomEvent.Reconnected, this.onReconnected.bind(this));
  }

  shareScreen(enabled: boolean): Promise<void> {
    return this.enqueueVideoOperation(() =>
      this.changeScreenShareState(enabled),
    );
  }

  private async changeScreenShareState(enabled: boolean): Promise<void> {
    log.info("shareScreen:", enabled);

    if (this.screenSharePending || enabled === this.isScreenSharing) {
      return;
    }

    const room = this.liveKitRoom;
    if (room?.state !== ConnectionState.Connected) {
      throw new Error(
        game.i18n?.localize(`${LANG_NAME}.screenShareNotConnected`) ??
          "Connect to LiveKit before sharing your screen.",
      );
    }

    if (
      enabled &&
      !this.avMaster.canUserBroadcastVideo(game.user?.id ?? "")
    ) {
      throw new Error(
        game.i18n?.localize(`${LANG_NAME}.screenShareNotAllowed`) ??
          "You do not have permission to share video.",
      );
    }

    this.screenSharePending = true;
    this.updateScreenShareButtons();

    try {
      if (enabled) {
        const screenTracks = await createLocalScreenTracks({
          audio: false,
          video: true,
          contentHint: "detail",
          preferCurrentTab: false,
          selfBrowserSurface: "include",
          surfaceSwitching: "include",
        });

        const screenVideoTrack = screenTracks.find(
          (track): track is LocalVideoTrack =>
            track instanceof LocalVideoTrack,
        );
        if (!screenVideoTrack) {
          for (const track of screenTracks) {
            track.stop();
          }
          throw new Error(
            game.i18n?.localize(`${LANG_NAME}.screenShareNoVideo`) ??
              "The selected source did not provide video.",
          );
        }

        this.screenTracks = screenTracks;
        screenVideoTrack.mediaStreamTrack.addEventListener(
          "ended",
          () => {
            if (this.screenTracks.includes(screenVideoTrack)) {
              this.shareScreen(false).catch((error: unknown) => {
                log.error("Error stopping screen share:", error);
              });
            }
          },
          { once: true },
        );

        if (this.isTrackEnded(screenVideoTrack)) {
          throw new Error(
            game.i18n?.localize(`${LANG_NAME}.screenShareNoVideo`) ??
              "The selected screen source ended before it could be shared.",
          );
        }

        if (this.videoTrack) {
          this.restoreCameraAfterScreenShare =
            !this.videoTrack.isMuted &&
            [...room.localParticipant.videoTrackPublications.values()].some(
              (publication) => publication.track === this.videoTrack,
            );
          if (this.restoreCameraAfterScreenShare) {
            // Keep the camera publication and SID stable while sharing. Rapid
            // camera unpublish/republish cycles race delayed SFU subscription
            // and dynacast messages and can leave peers on a black frame.
            await this.videoTrack.mute();
          }
          this.videoTrack.detach();
        }

        for (const screenTrack of screenTracks) {
          await room.localParticipant.publishTrack(
            screenTrack,
            this.trackPublishOptions,
          );
          if (this.isTrackEnded(screenVideoTrack)) {
            throw new Error(
              game.i18n?.localize(`${LANG_NAME}.screenShareNoVideo`) ??
                "The selected screen source ended before it could be shared.",
            );
          }
        }
      } else {
        const screenTracks = this.screenTracks;
        this.screenTracks = [];

        for (const screenTrack of screenTracks) {
          log.debug("screenTrack disable:", screenTrack);
          await room.localParticipant
            .unpublishTrack(screenTrack)
            .catch((error: unknown) => {
              log.debug("Screen track was already unpublished:", error);
            });
          screenTrack.detach();
          screenTrack.stop();
        }

        if (this.restoreCameraAfterScreenShare && this.videoTrack) {
          await this.videoTrack.unmute();
        }
        this.restoreCameraAfterScreenShare = false;
        this.renderAndReattachLocalVideo();
      }
    } catch (error) {
      const screenTracks = this.screenTracks;
      this.screenTracks = [];
      for (const screenTrack of screenTracks) {
        await room.localParticipant
          .unpublishTrack(screenTrack)
          .catch(() => undefined);
        screenTrack.detach();
        screenTrack.stop();
      }

      if (this.restoreCameraAfterScreenShare && this.videoTrack) {
        await this.videoTrack
          .unmute()
          .catch((unmuteError: unknown) => {
            log.error("Error restoring camera after screen share:", unmuteError);
          });
      }
      this.restoreCameraAfterScreenShare = false;
      this.renderAndReattachLocalVideo();
      throw error;
    } finally {
      this.screenSharePending = false;
      this.updateScreenShareButtons();
    }
  }

  get trackPublishOptions(): TrackPublishOptions {
    const trackPublishOptions: TrackPublishOptions = {
      audioPreset: this.getAudioPreset(),
      simulcast: true,
      videoCodec: "vp8",
      videoSimulcastLayers: [VideoPresets43.h180, VideoPresets43.h360],
    };

    if (game.settings?.get(MODULE_NAME, "audioMusicMode")) {
      trackPublishOptions.audioPreset = AudioPresets.musicHighQuality;
    }

    return trackPublishOptions;
  }

  getAudioPreset(): AudioPreset {
    const preset = game.settings?.get(MODULE_NAME, "audioQualityPreset");
    switch (preset) {
      case "telephone":
        return AudioPresets.telephone;
      case "music":
        return AudioPresets.music;
      case "musicStereo":
        return AudioPresets.musicStereo;
      case "musicHighQuality":
        return AudioPresets.musicHighQuality;
      case "musicHighQualityStereo":
        return AudioPresets.musicHighQualityStereo;
      case "speech":
      default:
        return AudioPresets.speech;
    }
  }
}
