import { createContext, useContext } from "react";

export const ConfigContext = createContext(null);

export function useAppConfig() {
  const config = useContext(ConfigContext);
  if (!config)
    throw new Error("useAppConfig must be used inside ConfigContext");
  return config;
}
