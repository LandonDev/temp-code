import { Component, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";

/**
 * The window's last boundary, around the whole app: a render error no
 * surface boundary held would otherwise unmount everything and leave a
 * blank window. It says so in one line and offers the one way back.
 */
export class RootBoundary extends Component<
  { children: ReactNode; reload?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.reload ?? (() => location.reload());
    return (
      <div role="alert" className="flex h-screen w-full flex-col bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Something broke</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={reload}>
              Reload window
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
}
