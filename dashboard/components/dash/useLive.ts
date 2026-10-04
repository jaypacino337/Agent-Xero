"use client";
import { useEffect, useRef, useState } from "react";
import { fetchLive, type LiveData } from "@/lib/api";
import { site } from "@/lib/site";

/** Polls the agent API; pauses while the tab is hidden. */
export function useLive() {
  const [data, setData] = useState<LiveData | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      const d = await fetchLive();
      busy.current = false;
      if (!alive) return;
      if (d) {
        setData(d);
        setLastSync(Date.now());
        setOffline(false);
      } else setOffline(true);
    };
    void tick();
    const id = setInterval(tick, site.pollMs);
    const onVis = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return { data, lastSync, offline };
}

/** A clock that re-renders every second (for "synced 3s ago", uptime, etc). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
