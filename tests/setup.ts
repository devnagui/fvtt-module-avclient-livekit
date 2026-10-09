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

function flattenObject(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(
        flattened,
        flattenObject(child as Record<string, unknown>, path),
      );
    } else {
      flattened[path] = child;
    }
  }
  return flattened;
}

Object.assign(globalThis, {
  AudioWorkletNode: MockAudioWorkletNode,
  foundry: {
    av: {
      AVClient: MockAVClient,
    },
    applications: {
      instances: new Map(),
      settings: {
        menus: {
          AVConfig: MockAVConfig,
        },
      },
    },
    utils: {
      debounce: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
      flattenObject,
    },
  },
  Hooks: {
    callAll: () => undefined,
    once: () => undefined,
  },
  game: {
    user: { id: "self" },
  },
});
