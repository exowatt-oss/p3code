import { Component, lazy, Suspense, type ReactNode } from "react";

const PetsOverlay = lazy(() => import("./PetsOverlay"));

// A pet or storage failure must never take the coding workspace down.
class PetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function P3PetsHost() {
  return (
    <PetBoundary>
      <Suspense fallback={null}>
        <PetsOverlay />
      </Suspense>
    </PetBoundary>
  );
}
