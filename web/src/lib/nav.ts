import { useNavigate, useSearchParams } from 'react-router-dom';

/** Screen state lives in the query string. `patch` sets or (with null) clears keys; `reset` starts from an empty query. */
export function useQueryNav() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return {
    params,
    get: (key: string) => params.get(key),
    patch(changes: Record<string, string | null | undefined>, reset = false) {
      const next = new URLSearchParams(reset ? '' : params);
      for (const [k, v] of Object.entries(changes)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const search = next.toString();
      navigate({ pathname: '/', search: search ? `?${search}` : '' });
    },
  };
}
