import { useSyncExternalStore } from "react";
const media = window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (listener: () => void) => {
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
export const useMotionPreference = () =>
  useSyncExternalStore(
    subscribe,
    () => media.matches,
    () => true,
  );
