package dev.craftarena.replaymyopia.mixin;

import com.mojang.blaze3d.systems.RenderSystem;
import dev.craftarena.replaymyopia.MyopiaClient;
import net.minecraft.client.render.BackgroundRenderer;
import net.minecraft.client.render.Camera;
import net.minecraft.client.render.FogShape;
import net.minecraft.client.world.ClientWorld;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(BackgroundRenderer.class)
public abstract class BackgroundRendererMixin {
    @Shadow private static float red;
    @Shadow private static float green;
    @Shadow private static float blue;

    @Inject(method = "render", at = @At("TAIL"))
    private static void myopia$background(Camera camera, float tickDelta, ClientWorld world,
                                           int viewDistance, float skyDarkness, CallbackInfo ci) {
        if (!MyopiaClient.INSTANCE.active()) return;
        red = green = blue = 0f;
        RenderSystem.clearColor(0f, 0f, 0f, 1f);
    }

    @Inject(method = "applyFog", at = @At("TAIL"))
    private static void myopia$fog(Camera camera, BackgroundRenderer.FogType type, float viewDistance,
                                  boolean thickFog, float tickDelta, CallbackInfo ci) {
        if (!MyopiaClient.INSTANCE.active()) return;
        float radius = MyopiaClient.INSTANCE.radius();
        // Retain a stricter vanilla fog (underwater, blindness, darkness) when present.
        RenderSystem.setShaderFogStart(Math.min(RenderSystem.getShaderFogStart(), radius * 0.85f));
        RenderSystem.setShaderFogEnd(Math.min(RenderSystem.getShaderFogEnd(), radius));
        RenderSystem.setShaderFogShape(FogShape.SPHERE);
        RenderSystem.setShaderFogColor(0f, 0f, 0f, 1f);
    }
}
