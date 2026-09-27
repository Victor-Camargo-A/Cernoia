"use client";
import { useEffect } from "react";
export function LegacyEntry() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (["reset_token", "invite_token", "billing", "notification_channel"].some(key => params.has(key))) {
      window.location.replace(`/acceso${window.location.search}${window.location.hash}`);
    }
  }, []);
  return null;
}
