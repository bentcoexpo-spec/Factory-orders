'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Role, Shop } from '@/lib/types';

interface RoleContextValue {
  role: Role | null;
  email: string | null;
  shop: Shop | null;
  loading: boolean;
  setShop: (shop: Shop) => Promise<void>;
}

const RoleContext = createContext<RoleContextValue>({
  role: null,
  email: null,
  shop: null,
  loading: true,
  setShop: async () => {},
});

export function useRole() {
  return useContext(RoleContext);
}

export default function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [shop, setShopState] = useState<Shop | null>(null);
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
          setShopState(null);
          setLoading(false);
        }
        return;
      }

      const { data } = await supabase.from('profiles').select('role, email, current_shop').eq('id', user.id).single();

      if (active) {
        setRole((data?.role as Role) ?? null);
        setEmail(data?.email ?? user.email ?? null);
        setShopState((data?.current_shop as Shop | null) ?? null);
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

  async function setShop(next: Shop) {
    const { error } = await supabase.rpc('set_my_shop', { p_shop: next });
    if (error) throw new Error(error.message);
    setShopState(next);
  }

  return <RoleContext.Provider value={{ role, email, shop, loading, setShop }}>{children}</RoleContext.Provider>;
}
