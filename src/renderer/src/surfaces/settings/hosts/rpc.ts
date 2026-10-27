import { registry } from "../../../lib/connection";

/** A request on this window's own host (the local server, or the served host in web mode). */
export const rpc = <T,>(method: string, params: unknown = {}): Promise<T> => registry.primary().request<T>(method, params);
