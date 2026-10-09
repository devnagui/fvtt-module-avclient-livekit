class MockAVClient {
  isVoicePTT = false;
}

class MockAVConfig {
  static DEFAULT_OPTIONS = {};
  readonly isMock = true;
}

class MockAudioWorkletNode {
  port = {
    onmessage: null,
    postMessage: () => undefined,
  };

  connect(): this {
    return this;
  }

  disconnect(): undefined {
    return undefined;
  }
}

Object.assign(globalThis, {
  AudioWorkletNode: MockAudioWorkletNode,
  foundry: {
    av: {
      AVClient: MockAVClient,
    },
    applications: {
      settings: {
        menus: {
          AVConfig: MockAVConfig,
        },
      },
    },
    utils: {
      debounce: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
    },
  },
  Hooks: {
    callAll: () => undefined,
    once: () => undefined,
  },
});
