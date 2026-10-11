package dev.craftarena.replaymyopia.mixin;

import dev.craftarena.replaymyopia.MyopiaClient;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.EntityRenderDispatcher;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(EntityRenderDispatcher.class)
public abstract class EntityRenderDispatcherMixin {
    @Inject(method = "render", at = @At("HEAD"), cancellable = true)
    private void myopia$hideDistantEntity(Entity entity, double x, double y, double z, float yaw,
            float tickDelta, MatrixStack matrices, VertexConsumerProvider vertices, int light, CallbackInfo ci) {
        // Covers model, nameplate, glowing outline, debug hitbox and shadow together.
        if (MyopiaClient.INSTANCE.hideAt(entity.getLerpedPos(tickDelta))) ci.cancel();
    }
}
