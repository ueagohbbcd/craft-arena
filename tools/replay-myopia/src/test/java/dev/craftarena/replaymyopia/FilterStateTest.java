package dev.craftarena.replaymyopia;

import org.junit.jupiter.api.Test;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class FilterStateTest {
    @Test void cannotActivateOutsideReplayOrWithoutTarget() {
        FilterState state = new FilterState();
        state.setEnabled(true);
        assertFalse(state.active());
        state.enterSession(new Object());
        state.setEnabled(true);
        assertFalse(state.active());
    }
    @Test void sameReplayKeepsUuidAcrossRefreshes() {
        FilterState state = new FilterState();
        Object replay = new Object();
        UUID uuid = UUID.randomUUID();
        state.enterSession(replay);
        state.bind(uuid);
        state.setEnabled(true);
        // No Entity or ClientWorld is stored. Those can be replaced while the replay stays identical.
        for (int i = 0; i < 5; i++) assertFalse(state.enterSession(replay));
        assertEquals(uuid, state.target());
        assertTrue(state.active());
    }
    @Test void closingOrChangingReplayResetsBindingAndFilter() {
        FilterState state = new FilterState();
        state.enterSession(new Object());
        state.bind(UUID.randomUUID());
        state.setEnabled(true);
        assertTrue(state.enterSession(new Object()));
        assertNull(state.target());
        assertFalse(state.active());
        state.enterSession(null);
        assertFalse(state.active());
    }
    @Test void disablingKeepsBindingForEasyReenable() {
        FilterState state = new FilterState();
        state.enterSession(new Object());
        UUID uuid = UUID.randomUUID();
        state.bind(uuid);
        state.setEnabled(true);
        state.setEnabled(false);
        assertFalse(state.active());
        assertEquals(uuid, state.target());
        state.setEnabled(true);
        assertTrue(state.active());
    }
    @Test void radiusIsBoundedAndBoundaryIsIncluded() {
        FilterState state = new FilterState();
        assertEquals(16, state.radius());
        assertFalse(state.outside(256));
        assertTrue(state.outside(256.01));
        state.setRadius(Integer.MIN_VALUE);
        assertEquals(2, state.radius());
        state.setRadius(Integer.MAX_VALUE);
        assertEquals(128, state.radius());
    }
}
