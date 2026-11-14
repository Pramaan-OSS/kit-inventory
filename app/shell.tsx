"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useResource } from "../lib/pramaan/client";
export type User = { id: string; email: string | null; role: string };
export function Shell({ children }: { children: ReactNode }) {
  const { data } = useResource<{ user: User }>("/api/account/session");
  const owner = data?.user?.role === "owner";
  return (
    <>
      <header>
        <nav aria-label="Main">
          <Link href="/">Inventory and orders</Link>
          {data?.user && <Link href="/stock">Stock and orders</Link>}
          {owner && (
            <>
              <Link href="/settings">Shop settings</Link>
              <Link href="/owner">Owner settings</Link>
            </>
          )}
        </nav>
      </header>
      {children}
    </>
  );
}
