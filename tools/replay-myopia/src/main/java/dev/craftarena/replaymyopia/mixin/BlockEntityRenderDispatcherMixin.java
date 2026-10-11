package dev.craftarena.replaymyopia.mixin;

import dev.craftarena.replaymyopia.MyopiaClient;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.block.entity.BlockEntityRenderDispatcher;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.util.math.Vec3d;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(BlockEntityRenderDispatcher.class)
public abstract class BlockEntityRenderDispatcherMixin {
    @Inject(method = "render(Lnet/minecraft/block/entity/BlockEntity;FLnet/minecraft/client/util/math/MatrixStack;Lnet/minecraft/client/render/VertexConsumerProvider;)V",
            at = @At("HEAD"), cancellable = true)
    private void myopia$hideDistantBlockEntity(BlockEntity entity, float tickDelta, MatrixStack matrices,
            VertexConsumerProvider vertices, CallbackInfo ci) {
        if (MyopiaClient.INSTANCE.hideAt(Vec3d.ofCenter(entity.getPos()))) ci.cancel();
    }
}
