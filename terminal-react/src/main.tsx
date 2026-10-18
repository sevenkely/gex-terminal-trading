import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/api";
import App, { BootstrapError } from "./App";
import "./styles.css";
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <BootstrapError message="Un composant a rencontré une erreur. Vos données et préférences classiques restent intactes." />
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </Boundary>,
);
