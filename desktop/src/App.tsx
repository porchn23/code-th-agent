import { useEffect, useState, useSyncExternalStore } from "react";
import { store } from "./store";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ChatPane from "./components/ChatPane";
import InputBar from "./components/InputBar";
import Drawer from "./components/Drawer";

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [drawer, setDrawer] = useState<string | null>(null);

  useEffect(() => {
    store.init();
    return () => store.dispose();
  }, []);

  return (
    <div className="app">
      <Sidebar state={state} />
      <main className="main">
        <TopBar state={state} onOpenPanel={setDrawer} />
        <ChatPane state={state} />
        <InputBar state={state} />
      </main>
      <Drawer state={state} panel={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
