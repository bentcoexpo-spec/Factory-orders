'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Role } from '@/lib/types';

interface RoleContextValue {
  role: Role | null;
  email: string | null;
  loading: boolean;
}

const RoleContext = createContext<RoleContextValue>({ role: null, email: null, loading: true });

export function useRole() {
  return useContext(RoleContext);
}

export default function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadRole() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (active) {
          setRole(null);
          setEmail(null);
          setLoading(false);
        }
        return;
      }

      const { data } = await supabase.from('profiles').select('role, email').eq('id', user.id).single();

      if (active) {
        setRole((data?.role as Role) ?? null);
        setEmail(data?.email ?? user.email ?? null);
        setLoading(false);
      }
    }

    loadRole();
    const { data: listener } = supabase.auth.onAuthStateChange(() => loadRole());
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return <RoleContext.Provider value={{ role, email, loading }}>{children}</RoleContext.Provider>;
}
