package dev.craftarena.replaymyopia;

import com.replaymod.replay.ReplayHandler;
import com.replaymod.replay.ReplayModReplay;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.option.Perspective;
import net.minecraft.client.util.InputUtil;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.util.math.Vec3d;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Properties;
import java.util.UUID;

public final class MyopiaClient implements ClientModInitializer {
    public static final MyopiaClient INSTANCE = new MyopiaClient();
    private static final Logger LOGGER = LoggerFactory.getLogger("replay-myopia");
    private final FilterState state = new FilterState();
    private ReplayHandler replay;
    private PlayerEntity targetEntity;
    private String targetName = "";
    private Perspective previousPerspective;
    private KeyBinding settingsKey;
    private KeyBinding toggleKey;
    private KeyBinding smallerKey;
    private KeyBinding largerKey;

    @Override
    public void onInitializeClient() { INSTANCE.initialize(); }

    private void initialize() {
        loadRadius();
        settingsKey = key("settings", GLFW.GLFW_KEY_F8);
        toggleKey = key("toggle", GLFW.GLFW_KEY_F9);
        smallerKey = key("smaller", GLFW.GLFW_KEY_LEFT_BRACKET);
        largerKey = key("larger", GLFW.GLFW_KEY_RIGHT_BRACKET);
        ClientTickEvents.END_CLIENT_TICK.register(client -> { refresh(); handleKeys(client); });
        HudRenderCallback.EVENT.register((draw, tickCounter) -> {
            if (replay == null) return;
            String status = state.active()
                    ? "Myopia: " + targetName + " | " + state.radius() + " blocks"
                        + (targetEntity == null ? " | waiting for player" : "")
                    : "Myopia OFF | full replay";
            draw.drawTextWithShadow(MinecraftClient.getInstance().textRenderer, status, 8,
                    draw.getScaledWindowHeight() - 34, state.active() ? 0xffffaa : 0xffffff);
            draw.drawTextWithShadow(MinecraftClient.getInstance().textRenderer,
                    "Illustration only | F8 settings / F9 toggle", 8, draw.getScaledWindowHeight() - 22, 0xaaaaaa);
        });
    }

    private static KeyBinding key(String name, int code) {
        return KeyBindingHelper.registerKeyBinding(new KeyBinding("key.replay_myopia." + name,
                InputUtil.Type.KEYSYM, code, "category.replay_myopia"));
    }

    /** Called before camera setup on every rendered frame, including paused replays. */
    public void beforeWorldRender() {
        refresh();
        handleKeys(MinecraftClient.getInstance());
        if (!state.active()) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (previousPerspective == null) previousPerspective = client.options.getPerspective();
        client.options.setPerspective(Perspective.FIRST_PERSON);
        if (targetEntity != null && client.getCameraEntity() != targetEntity) replay.spectateEntity(targetEntity);
    }

    private void handleKeys(MinecraftClient client) {
        if (settingsKey == null) return;
        while (settingsKey.wasPressed()) {
            if (replay != null && client.currentScreen == null) client.setScreen(new MyopiaScreen(this));
        }
        while (toggleKey.wasPressed()) { if (replay != null) toggle(); }
        while (smallerKey.wasPressed()) { if (replay != null) setRadius(state.radius() - 2); }
        while (largerKey.wasPressed()) { if (replay != null) setRadius(state.radius() + 2); }
    }

    private void refresh() {
        MinecraftClient client = MinecraftClient.getInstance();
        ReplayHandler next = ReplayModReplay.instance == null ? null : ReplayModReplay.instance.getReplayHandler();
        if (state.enterSession(next)) {
            restorePerspective();
            replay = next;
            targetName = "";
        }
        // Never retain an Entity across a rewind, world replacement, death or dimension change.
        targetEntity = client.world == null || state.target() == null ? null : client.world.getPlayerByUuid(state.target());
        if (targetEntity != null && targetEntity.isRemoved()) targetEntity = null;
        if (targetEntity != null) targetName = targetEntity.getGameProfile().getName();
    }

    public void bind(UUID uuid, String name) {
        if (replay == null) return;
        state.bind(uuid);
        targetName = name;
        state.setEnabled(true);
        refresh();
    }

    public void toggle() {
        if (replay == null) return;
        if (state.enabled()) { disable(); return; }
        if (state.target() == null) {
            Entity camera = MinecraftClient.getInstance().getCameraEntity();
            if (camera instanceof PlayerEntity player && camera != replay.getCameraEntity()) {
                bind(player.getUuid(), player.getGameProfile().getName());
            } else {
                MinecraftClient.getInstance().setScreen(new MyopiaScreen(this));
            }
        } else state.setEnabled(true);
    }

    public void disable() {
        state.setEnabled(false);
        restorePerspective();
        if (replay != null) replay.spectateCamera();
    }

    private void restorePerspective() {
        if (previousPerspective != null) {
            MinecraftClient.getInstance().options.setPerspective(previousPerspective);
            previousPerspective = null;
        }
    }

    public boolean active() { return state.active(); }
    public boolean waiting() { return state.active() && targetEntity == null; }
    public int radius() { return state.radius(); }
    public UUID targetUuid() { return state.target(); }
    public String targetName() { return targetName; }
    public boolean inReplay() { return replay != null; }
    public void setRadius(int radius) { state.setRadius(radius); saveRadius(); }

    public boolean hideAt(Vec3d position) {
        return state.active() && (targetEntity == null || state.outside(targetEntity.getEyePos().squaredDistanceTo(position)));
    }

    public List<PlayerEntity> players() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.world == null || replay == null) return List.of();
        return client.world.getPlayers().stream().filter(p -> p != replay.getCameraEntity())
                .map(p -> (PlayerEntity) p).sorted(Comparator.comparing(p -> p.getGameProfile().getName())).toList();
    }

    private Path configPath() { return FabricLoader.getInstance().getConfigDir().resolve("replay-myopia.properties"); }
    private void loadRadius() {
        if (!Files.isRegularFile(configPath())) return;
        try (Reader reader = Files.newBufferedReader(configPath())) {
            Properties properties = new Properties();
            properties.load(reader);
            state.setRadius(Integer.parseInt(properties.getProperty("radius", "16")));
        } catch (IOException | NumberFormatException e) { LOGGER.warn("Could not load radius; using default", e); }
    }
    private void saveRadius() {
        try {
            Files.createDirectories(configPath().getParent());
            try (Writer writer = Files.newBufferedWriter(configPath())) {
                Properties properties = new Properties();
                properties.setProperty("radius", Integer.toString(state.radius()));
                properties.store(writer, "Replay-only illustrative radius in blocks; binding and enabled state are never saved.");
            }
        } catch (IOException e) { LOGGER.warn("Could not save radius", e); }
    }
}
