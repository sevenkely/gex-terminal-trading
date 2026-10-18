import { create } from "zustand";
export const useInspection = create<{
  time: number | null;
  setTime: (time: number | null) => void;
}>((set) => ({ time: null, setTime: (time) => set({ time }) }));
