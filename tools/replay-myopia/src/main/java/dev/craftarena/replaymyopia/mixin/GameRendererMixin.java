package dev.craftarena.replaymyopia.mixin;

import com.mojang.blaze3d.systems.RenderSystem;
import dev.craftarena.replaymyopia.MyopiaClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.render.GameRenderer;
import net.minecraft.client.render.RenderTickCounter;
import org.lwjgl.opengl.GL11;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
public abstract class GameRendererMixin {
    @Inject(method = "renderWorld", at = @At("HEAD"), cancellable = true)
    private void myopia$beforeCamera(RenderTickCounter tickCounter, CallbackInfo ci) {
        MyopiaClient.INSTANCE.beforeWorldRender();
        if (MyopiaClient.INSTANCE.waiting()) {
            // No stale camera fallback while a rewind/respawn recreates the UUID's entity.
            RenderSystem.clearColor(0f, 0f, 0f, 1f);
            RenderSystem.clear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT, MinecraftClient.IS_SYSTEM_MAC);
            ci.cancel();
        }
    }
}
