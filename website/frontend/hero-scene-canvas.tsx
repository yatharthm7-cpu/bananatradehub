'use client';

import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';

// The decorative hero scene: a small voxel platform under a floating sign
// that carries the official BananaSMP logo. Geometry is real (instanced-free
// bounded box count), lighting is two restrained rim lights, and motion is a
// gentle bob plus a camera nudge driven by page scroll. Nothing here is a
// listing, item, or trade state.

const PLATFORM = 7;            // 7x7 voxel tiles
const TILE = 1;                // world units per tile
const heights = [
  2, 2, 3, 3, 2, 2, 1,
  2, 3, 4, 4, 3, 2, 1,
  3, 4, 5, 5, 4, 3, 2,
  3, 4, 5, 5, 4, 3, 2,
  2, 3, 4, 4, 3, 2, 1,
  2, 2, 3, 3, 2, 2, 1,
  1, 1, 2, 2, 1, 1, 1,
];
const stoneTints = ['#1d1c24', '#211f2a', '#26232f', '#1a1920'];

function VoxelPlatform() {
  const tiles = [];
  for (let row = 0; row < PLATFORM; row += 1) {
    for (let column = 0; column < PLATFORM; column += 1) {
      const index = row * PLATFORM + column;
      const height = heights[index];
      const tint = stoneTints[(row + column) % stoneTints.length];
      const edge = row === 0 || column === 0 || row === PLATFORM - 1 || column === PLATFORM - 1;
      tiles.push(
        <mesh
          key={index}
          position={[(column - (PLATFORM - 1) / 2) * TILE, height / 2 - 1.5, (row - (PLATFORM - 1) / 2) * TILE]}
          castShadow receiveShadow
        >
          <boxGeometry args={[TILE * 0.94, height, TILE * 0.94]} />
          <meshStandardMaterial color={tint} emissive={edge ? '#4b2d66' : '#000000'} emissiveIntensity={edge ? 0.55 : 0} roughness={0.85} metalness={0.05} />
        </mesh>
      );
    }
  }
  return <group>{tiles}</group>;
}

interface SignProps { ready: () => void }

function FloatingSign({ ready }: SignProps) {
  const texture = useLoader(THREE.TextureLoader, '/logo.png');
  const group = useRef<THREE.Group>(null);
  const reported = useRef(false);
  useEffect(() => {
    texture.anisotropy = 4;
    texture.colorSpace = THREE.SRGBColorSpace;
    return () => { texture.dispose(); };
  }, [texture]);
  useFrame((state) => {
    if (!group.current) return;
    const time = state.clock.elapsedTime;
    group.current.position.y = 2.15 + Math.sin(time * 0.9) * 0.09;
    group.current.rotation.y = Math.sin(time * 0.35) * 0.12;
    if (!reported.current) { reported.current = true; ready(); }
  });
  return (
    <group ref={group} position={[0, 2.15, 0]}>
      <mesh position={[0, 0, -0.11]} castShadow>
        <boxGeometry args={[2.6, 1.35, 0.18]} />
        <meshStandardMaterial color="#28203a" emissive="#6a3f94" emissiveIntensity={0.35} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0, -0.08]}>
        <boxGeometry args={[2.42, 1.18, 0.06]} />
        <meshStandardMaterial color="#17151f" />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[2.1, 0.92]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} />
      </mesh>
      {/* Support struts down to the platform, subtly lit. */}
      <mesh position={[-1.05, -1.25, 0]}><boxGeometry args={[0.09, 1.9, 0.09]} /><meshStandardMaterial color="#3a2c4d" /></mesh>
      <mesh position={[1.05, -1.25, 0]}><boxGeometry args={[0.09, 1.9, 0.09]} /><meshStandardMaterial color="#3a2c4d" /></mesh>
    </group>
  );
}

interface SceneContentsProps {
  scrollProgress: { current: number };
  onReady?: () => void;
}

function SceneContents({ scrollProgress, onReady }: SceneContentsProps) {
  const group = useRef<THREE.Group>(null);
  const pointer = useRef({ x: 0, target: 0 });
  useFrame((state) => {
    if (!group.current) return;
    // Scroll: a restrained camera-style dolly/tilt. Reduced motion never runs
    // this path because the canvas is not mounted.
    const progress = scrollProgress.current;
    state.camera.position.x = 5.4 + progress * 1.6;
    state.camera.position.y = 3.1 - progress * 0.7;
    state.camera.lookAt(0, 0.4, 0);
    // Pointer parallax: eased and tiny, desktop pointer events only.
    pointer.current.target *= 0.94;
    pointer.current.x += (pointer.current.target - pointer.current.x) * 0.06;
    group.current.rotation.y = 0.35 + pointer.current.x * 0.22;
  });
  return (
    <group
      ref={group}
      onPointerMove={event => { pointer.current.target = (event.clientX / window.innerWidth) * 2 - 1; }}
    >
      <VoxelPlatform />
      <FloatingSign ready={() => onReady?.()} />
    </group>
  );
}

interface HeroCanvasProps {
  active: boolean;
  scrollProgress: { current: number };
  onReady?: () => void;
}

export default function HeroCanvas({ active, scrollProgress, onReady }: HeroCanvasProps) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      frameloop={active ? 'always' : 'never'}
      camera={{ position: [5.4, 3.1, 7.2], fov: 42 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      onCreated={({ gl }) => {
        gl.setClearColor('#12101a');
        if (onReady) onReady();
      }}
    >
      <fog attach="fog" args={['#12101a', 12, 22]} />
      <ambientLight intensity={0.32} color="#cbb9e8" />
      <directionalLight position={[6, 8, 4]} intensity={1.1} color="#f4d9ff" castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[-5, 3, -2]} intensity={38} color="#b275ff" distance={14} />
      <pointLight position={[5, 2.5, 5]} intensity={26} color="#f1a6f6" distance={13} />
      <SceneContents scrollProgress={scrollProgress} onReady={onReady} />
    </Canvas>
  );
}
