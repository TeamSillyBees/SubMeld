"use client"

import * as React from "react"
import { cn } from "cn"

function Table({
  className,
  scrollLabel,
  ...props
}) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
      role={scrollLabel ? "region" : undefined}
      aria-label={scrollLabel}
      tabIndex={scrollLabel ? 0 : undefined}
    >
      <table
        data-slot="table"
        role="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({
  className,
  ...props
}) {
  return (
    <thead
      data-slot="table-header"
      role="rowgroup"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({
  className,
  ...props
}) {
  return (
    <tbody
      data-slot="table-body"
      role="rowgroup"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({
  className,
  ...props
}) {
  return (
    <tfoot
      data-slot="table-footer"
      role="rowgroup"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({
  className,
  ...props
}) {
  return (
    <tr
      data-slot="table-row"
      role="row"
      className={cn(
        "border-b hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  ...props
}) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      role="columnheader"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  mobileLabel,
  children,
  ...props
}) {
  return (
    <td
      data-slot="table-cell"
      role="cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    >
      {mobileLabel && <span className="mobile-cell-label" aria-hidden="true">{mobileLabel}</span>}
      {children}
    </td>
  )
}

function TableCaption({
  className,
  ...props
}) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
