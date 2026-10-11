package dev.craftarena.replaymyopia;

import java.util.UUID;

/** Session identity, not world/entity identity: rewinds recreate both of those. */
public final class FilterState {
    public static final int DEFAULT_RADIUS = 16;
    public static final int MIN_RADIUS = 2;
    public static final int MAX_RADIUS = 128;
    private Object session;
    private UUID target;
    private boolean enabled;
    private int radius = DEFAULT_RADIUS;

    public boolean enterSession(Object next) {
        if (session == next) return false;
        session = next;
        target = null;
        enabled = false;
        return true;
    }

    public boolean active() { return session != null && enabled && target != null; }
    public UUID target() { return target; }
    public boolean enabled() { return enabled; }
    public int radius() { return radius; }
    public void bind(UUID uuid) { target = uuid; }
    public void setEnabled(boolean value) { enabled = value && session != null && target != null; }
    public void setRadius(int value) { radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, value)); }
    public boolean outside(double distanceSquared) { return distanceSquared > (double) radius * radius; }
}
