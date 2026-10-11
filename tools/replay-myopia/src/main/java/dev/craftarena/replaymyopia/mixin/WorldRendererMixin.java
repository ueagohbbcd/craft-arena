package dev.craftarena.replaymyopia.mixin;

import dev.craftarena.replaymyopia.MyopiaClient;
import net.minecraft.client.render.WorldRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(WorldRenderer.class)
public abstract class WorldRendererMixin {
    // These global layers do not consistently participate in terrain fog.
    @Inject(method = {"renderSky", "renderClouds", "renderWeather"}, at = @At("HEAD"), cancellable = true)
    private void myopia$hideGlobalLayers(CallbackInfo ci) {
        if (MyopiaClient.INSTANCE.active()) ci.cancel();
    }
}
