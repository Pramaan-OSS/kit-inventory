"use client";
import { api } from "../lib/pramaan/client";
export const send = <T,>(url: string, input: object) =>
  api<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
