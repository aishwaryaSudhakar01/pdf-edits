import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95 hover:-translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-md hover:shadow-lg hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow hover:bg-destructive/90",
        outline:
          "border-2 border-input bg-background/60 backdrop-blur-sm shadow-sm hover:bg-accent hover:text-accent-foreground hover:border-primary",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        positive: "text-primary-foreground shadow-md hover:shadow-lg [background-image:var(--gradient-playful)] bg-primary",
        tertiary: "bg-transparent text-foreground hover:bg-accent",
      },
      size: {
        default: "h-9 px-5 py-2",
        sm: "h-8 rounded-full px-3 text-xs",
        lg: "h-11 rounded-full px-8 text-base",
        icon: "h-9 w-9",
        compact: "h-8 px-4 text-xs",
        mini: "h-7 px-3 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, isLoading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
