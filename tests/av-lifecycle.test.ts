import { beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import LiveKitAVClient, {
  getBlockedUserIds,
  getLocalAVActivity,
} from "../src/LiveKitAVClient";
import LiveKitClient from "../src/LiveKitClient";
import { debounceRefreshView } from "../src/utils/helpers";

describe("cross-version camera rendering", () => {
  it("uses a full CameraViews render instead of a dynamic user part", async () => {
    vi.useFakeTimers();
    const render = vi.fn(() => Promise.resolve());
    Object.assign(globalThis, { ui: { webrtc: { render } } });

    debounceRefreshView("user-a");
    await vi.runAllTimersAsync();

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith();
    vi.useRealTimers();
  });
});

describe("Foundry AV state semantics", () => {
  it("detects receiver-local blocked user setting changes", () => {
    expect(
      getBlockedUserIds([
        "client.users.user-a.blocked",
        "client.users.user-a.volume",
        "client.users.user-b.blocked",
      ]),
    ).toEqual(["user-a", "user-b"]);
  });

  it("broadcasts actual initial mute state separately from source availability", () => {
    expect(
      getLocalAVActivity({
        audioTrack: { isMuted: true },
        videoTrack: { isMuted: true },
        isScreenSharing: false,
      }),
    ).toEqual({ muted: true, hidden: true });

    expect(
      getLocalAVActivity({
        audioTrack: { isMuted: false },
        videoTrack: { isMuted: true },
        isScreenSharing: true,
      }),
    ).toEqual({ muted: false, hidden: false });
  });

  it("reports a muted microphone track as an available audio source", () => {
    const client = Object.create(LiveKitAVClient.prototype) as LiveKitAVClient;
    Object.assign(client, {
      _liveKitClient: {
        audioTrack: { isMuted: true },
      },
    });

    expect(client.isAudioEnabled()).toBe(true);
  });

  it("allows always-on audio to recover when audioBroadcastEnabled is false", () => {
    const client = Object.create(LiveKitAVClient.prototype) as LiveKitAVClient;
    const toggleBroadcast = vi.fn();
    Object.assign(client, {
      _liveKitClient: {
        useExternalAV: false,
        audioBroadcastEnabled: false,
      },
      isVoicePTT: false,
      toggleBroadcast,
    });

    client.toggleAudio(true);

    expect(toggleBroadcast).toHaveBeenCalledOnce();
    expect(toggleBroadcast).toHaveBeenCalledWith(true);
  });

  it("does not open the microphone merely by unmuting in push-to-talk mode", () => {
    const client = Object.create(LiveKitAVClient.prototype) as LiveKitAVClient;
    const toggleBroadcast = vi.fn();
    Object.assign(client, {
      _liveKitClient: {
        useExternalAV: false,
        audioBroadcastEnabled: false,
      },
      isVoicePTT: true,
      toggleBroadcast,
    });

    client.toggleAudio(true);

    expect(toggleBroadcast).not.toHaveBeenCalled();
  });
});

describe("remote audio lifecycle", () => {
  let client: LiveKitClient;

  beforeEach(() => {
    document.body.replaceChildren();
    client = Object.create(LiveKitClient.prototype) as LiveKitClient;
  });

  it("keeps remote audio connected when its camera view is removed", () => {
    const cameraView = document.createElement("div");
    cameraView.className = "camera-view";
    cameraView.dataset.user = "user-a";
    document.body.append(cameraView);

    const audioElement = client.getUserAudioElement(
      "user-a",
      Track.Source.Microphone,
    );
    cameraView.remove();

    expect(audioElement.isConnected).toBe(true);
    expect(audioElement.closest("#livekit-remote-audio-container")).not.toBeNull();
  });

  it("reuses one playback element per participant and source", () => {
    const first = client.getUserAudioElement(
      "user-a",
      Track.Source.Microphone,
    );
    const repeated = client.getUserAudioElement(
      "user-a",
      Track.Source.Microphone,
    );
    const otherUser = client.getUserAudioElement(
      "user-b",
      Track.Source.Microphone,
    );

    expect(repeated).toBe(first);
    expect(otherUser).not.toBe(first);
    expect(
      document.querySelectorAll(
        "#livekit-remote-audio-container audio[data-livekit-remote-audio]",
      ),
    ).toHaveLength(2);
  });
});

describe("receiver-hidden video lifecycle", () => {
  it("returns a blocked detached camera to the dock and closes its popout", async () => {
    const close = vi.fn(() => Promise.resolve());
    const render = vi.fn(() => Promise.resolve());
    const set = vi.fn();
    foundry.applications.instances.set("camera-view-user-a", {
      close,
    } as never);

    const client = Object.create(LiveKitAVClient.prototype) as LiveKitAVClient;
    Object.assign(client, {
      _liveKitClient: {
        isUserVideoBlocked: () => true,
        reattachRemoteAudio: vi.fn(),
      },
      settings: {
        client: { voice: { mode: "always" } },
        set,
      },
      master: { render },
    });

    client.onSettingsChanged({
      client: { users: { "user-a": { blocked: true } } },
    });
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });

    expect(set).toHaveBeenCalledWith(
      "client",
      "users.user-a.popout",
      false,
    );
    expect(render).toHaveBeenCalled();
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(
      render.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(render.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("does not attach video for a user blocked by this receiver", () => {
    const client = Object.create(LiveKitClient.prototype) as LiveKitClient;
    const getUserVideoTrack = vi.fn();
    Object.assign(client, {
      settings: {
        getUser: () => ({ blocked: true }),
      },
      getUserVideoTrack,
    });

    client.reattachRemoteVideoForUser("user-a");

    expect(getUserVideoTrack).not.toHaveBeenCalled();
  });
});
