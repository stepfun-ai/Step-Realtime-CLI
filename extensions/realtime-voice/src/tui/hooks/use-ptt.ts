import { useCallback, useRef, useState } from "react";

const PTT_DEBOUNCE_MS = 200;

export function usePtt(): {
  isHeld: boolean;
  onKeyDown: (key: string) => void;
  onKeyUp: (key: string) => void;
} {
  const [isHeld, setIsHeld] = useState(false);
  const lastSpaceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onKeyDown = useCallback(
    (key: string) => {
      if (key !== " ") return;
      const now = Date.now();
      lastSpaceRef.current = now;

      if (!isHeld) {
        setIsHeld(true);
      }

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (Date.now() - lastSpaceRef.current >= PTT_DEBOUNCE_MS) {
          setIsHeld(false);
        }
      }, PTT_DEBOUNCE_MS);
    },
    [isHeld],
  );

  const onKeyUp = useCallback((_key: string) => {
    // Terminal doesn't emit keyup. PTT release is detected by debounce timeout.
  }, []);

  return { isHeld, onKeyDown, onKeyUp };
}
