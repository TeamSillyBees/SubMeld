"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({
  ...props
}: ToasterProps) => {

  return (
    <Sonner
      theme="light"
      containerAriaLabel="通知"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon aria-hidden="true" />
        ),
        info: (
          <InfoIcon aria-hidden="true" />
        ),
        warning: (
          <TriangleAlertIcon aria-hidden="true" />
        ),
        error: (
          <OctagonXIcon aria-hidden="true" />
        ),
        loading: (
          <Loader2Icon className="animate-spin" aria-hidden="true" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)"
        }
      }
      toastOptions={{
        closeButtonAriaLabel: "关闭通知",
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
}

export { Toaster }
