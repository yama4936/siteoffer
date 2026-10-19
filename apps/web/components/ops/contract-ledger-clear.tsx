"use client";

import Link from "next/link";

/** Reset edits even when the current URL is already the unfiltered list. */
export function ContractLedgerClear() {
  return (
    <Link
      href="/ops/contracts#contract-list"
      className="text-sm text-primary underline"
      onClick={(event) => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
          event.currentTarget.closest("form")?.reset();
      }}
    >
      条件をクリア
    </Link>
  );
}
