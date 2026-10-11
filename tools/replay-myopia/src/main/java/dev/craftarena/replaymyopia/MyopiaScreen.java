package dev.craftarena.replaymyopia;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.text.Text;
import java.util.List;

/** Deliberately small, dependency-free replay control panel. */
public final class MyopiaScreen extends Screen {
    private final MyopiaClient controller;
    private int page;

    public MyopiaScreen(MyopiaClient controller) {
        super(Text.literal("Replay myopia (illustration)"));
        this.controller = controller;
    }

    @Override
    protected void init() {
        int left = width / 2 - 155;
        int top = 65;
        addDrawableChild(ButtonWidget.builder(Text.literal(controller.active() ? "Disable / full replay" : "Enable bound player"),
                b -> { controller.toggle(); clearAndInit(); }).dimensions(left, top, 200, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("- 2"), b -> { controller.setRadius(controller.radius() - 2); clearAndInit(); })
                .dimensions(left + 205, top, 50, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("+ 2"), b -> { controller.setRadius(controller.radius() + 2); clearAndInit(); })
                .dimensions(left + 260, top, 50, 20).build());
        List<PlayerEntity> players = controller.players();
        int rows = Math.max(1, Math.min(6, (height - 175) / 24));
        int pageSize = rows * 2;
        page = Math.min(page, Math.max(0, (players.size() - 1) / pageSize));
        for (int index = 0; index < pageSize && page * pageSize + index < players.size(); index++) {
            PlayerEntity player = players.get(page * pageSize + index);
            String name = player.getGameProfile().getName();
            addDrawableChild(ButtonWidget.builder(Text.literal((player.getUuid().equals(controller.targetUuid()) ? "> " : "") + name),
                    b -> { controller.bind(player.getUuid(), name); close(); })
                    .dimensions(left + (index % 2) * 160, top + 36 + (index / 2) * 24, 150, 20).build());
        }
        int bottom = top + 42 + rows * 24;
        addDrawableChild(ButtonWidget.builder(Text.literal("Previous"), b -> { page = Math.max(0, page - 1); clearAndInit(); })
                .dimensions(left, bottom, 100, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Refresh / next"), b -> { page++; clearAndInit(); })
                .dimensions(left + 105, bottom, 100, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Done"), b -> close()).dimensions(left + 210, bottom, 100, 20).build());
    }

    @Override
    public void render(DrawContext draw, int mouseX, int mouseY, float delta) {
        super.render(draw, mouseX, mouseY, delta);
        draw.drawCenteredTextWithShadow(textRenderer, title, width / 2, 16, 0xffffff);
        draw.drawCenteredTextWithShadow(textRenderer, "Bound: " + (controller.targetName().isEmpty() ? "select a player below" : controller.targetName())
                + " | Radius: " + controller.radius(), width / 2, 32, 0xffffaa);
        draw.drawCenteredTextWithShadow(textRenderer, "Visual range only, not the model's actual observations", width / 2, 46, 0xaaaaaa);
    }
    @Override public boolean shouldPause() { return false; }
}
