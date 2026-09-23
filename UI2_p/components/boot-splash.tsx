"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SaosLogo } from "@/components/saos-logo";

const BOOT_DURATION_MS = 3000;

export function BootSplash({ open, ready }: { open: boolean; ready: boolean }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) {
      setProgress(100);
      return;
    }

    const startTime = Date.now();

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(100, (elapsed / BOOT_DURATION_MS) * 100);
      setProgress(pct);

      if (elapsed >= BOOT_DURATION_MS) {
        clearInterval(interval);
      }
    }, 40);

    return () => clearInterval(interval);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[#071a24] p-6"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, y: -24, filter: "blur(4px)" }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          role="status"
          aria-label="Opening local workspace"
        >
          <div className="w-full max-w-xs text-center">
            {/* Logo */}
            <div className="flex justify-center mb-5">
              <div className="border-2 border-[#5edc56] bg-[#0c2633] p-2 shadow-[3px_3px_0_#5edc56]">
                <SaosLogo size={48} />
              </div>
            </div>

            {/* Title */}
            <h1 className="font-display text-2xl font-black text-white tracking-tight">
              SAOS 2.0
            </h1>
            <p className="font-mono text-[10px] text-[#5edc56] font-bold mt-1 tracking-widest uppercase">
              by @pianlabs
            </p>

            {/* Loading bar */}
            <div className="mt-6 h-3 border-2 border-[#f4f8f9] bg-[#071922] shadow-[2px_2px_0_#0d2f3f]">
              <motion.div
                className="h-full bg-[#5edc56]"
                style={{ width: `${progress}%` }}
                transition={{ ease: "linear" }}
              />
            </div>

            <p className="mt-2 font-mono text-[10px] text-[#8fa8b3]">
              {progress >= 100 ? "Ready" : `Loading... ${Math.round(progress)}%`}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
