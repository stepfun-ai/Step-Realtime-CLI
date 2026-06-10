export interface MutableRef<T> {
  get(): T;
  set(value: T): void;
  isSet(): boolean;
}

export function createMutableRef<T>(label: string): MutableRef<T> {
  let value: T | undefined;

  return {
    get(): T {
      if (value === undefined) {
        throw new Error(`${label} is not initialized`);
      }
      return value;
    },

    set(nextValue: T): void {
      value = nextValue;
    },

    isSet(): boolean {
      return value !== undefined;
    },
  };
}
