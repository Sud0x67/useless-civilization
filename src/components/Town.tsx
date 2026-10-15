import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { World } from '../shared/schema';
import { hasEffect, places, profiles, type AgentId } from '../world/engine';
export interface CameraControls {
  zoom: (amount: number) => void;
  reset: () => void;
}
export function Town({
  world,
  selected,
  onSelect,
  night,
  controlsRef,
}: {
  world: World;
  selected: AgentId | null;
  onSelect: (id: AgentId) => void;
  night: boolean;
  controlsRef: Ref<CameraControls>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Record<string, HTMLButtonElement | null>>({});
  const latest = useRef({ world, selected, night });
  latest.current = { world, selected, night };
  const api = useRef<CameraControls>({ zoom() {}, reset() {} });
  const [fallback, setFallback] = useState(false);
  useImperativeHandle(
    controlsRef,
    () => ({ zoom: (n) => api.current.zoom(n), reset: () => api.current.reset() }),
    [],
  );
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      let zoom = 1;
      api.current = {
        zoom: (amount) => {
          zoom = Math.max(0.65, Math.min(1.7, zoom * (amount > 0 ? 1.15 : 0.87)));
          element.style.setProperty('--fallback-zoom', String(zoom));
        },
        reset: () => {
          zoom = 1;
          element.style.setProperty('--fallback-zoom', '1');
        },
      };
      setFallback(true);
      return;
    }
    element.prepend(renderer.domElement);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
    const initialCamera = new THREE.Vector3(18, 21, 24);
    camera.position.copy(initialCamera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 20;
    controls.maxDistance = 48;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.25;
    controls.maxAzimuthAngle = Math.PI * 1.3;
    api.current = {
      zoom: (n) => {
        camera.position
          .sub(controls.target)
          .multiplyScalar(n > 0 ? 0.87 : 1.13)
          .add(controls.target);
        controls.update();
      },
      reset: () => {
        camera.position.copy(initialCamera);
        controls.target.set(0, 0, 0);
        controls.update();
      },
    };
    const ambient = new THREE.AmbientLight(0x9fc3df, 1.1);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffe4ba, 2.2);
    sun.position.set(-8, 18, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 });
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x7ae5df, 1.3);
    rim.position.set(12, 8, -12);
    scene.add(rim);
    const material = (color: string | number, extra = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra });
    const mat = {
      grass: material('#405e57'),
      earth: material('#263c40'),
      rock: material('#1b2e38'),
      road: material('#a0a99b'),
      wood: material('#826d5b'),
      water: material('#519eaa', { metalness: 0.5, roughness: 0.2 }),
      cream: material('#d8d6c1'),
      dark: material('#384548'),
      glow: material('#ffe2a6', { emissive: '#ffc76d', emissiveIntensity: 1.5 }),
      teal: material('#77d2b4', { emissive: '#285f54', emissiveIntensity: 0.3 }),
    };
    function mesh(
      geometry: THREE.BufferGeometry,
      m: THREE.Material | THREE.Material[],
      x = 0,
      y = 0,
      z = 0,
      parent: THREE.Object3D = scene,
    ) {
      const obj = new THREE.Mesh(geometry, m);
      obj.position.set(x, y, z);
      obj.castShadow = true;
      obj.receiveShadow = true;
      parent.add(obj);
      return obj;
    }
    function box(
      w: number,
      h: number,
      d: number,
      m: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent = scene as THREE.Object3D,
    ) {
      return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, parent);
    }
    function cylinder(
      rt: number,
      rb: number,
      h: number,
      m: THREE.Material,
      x: number,
      y: number,
      z: number,
      n = 8,
      parent = scene as THREE.Object3D,
    ) {
      return mesh(new THREE.CylinderGeometry(rt, rb, h, n), m, x, y, z, parent);
    }
    const outline = new THREE.Shape();
    const w = 20,
      d = 17,
      r = 1.7;
    outline.moveTo(-w / 2 + r, -d / 2);
    outline.lineTo(w / 2 - r, -d / 2);
    outline.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
    outline.lineTo(w / 2, d / 2 - r);
    outline.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
    outline.lineTo(-w / 2 + r, d / 2);
    outline.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
    outline.lineTo(-w / 2, -d / 2 + r);
    outline.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
    const island = mesh(
      new THREE.ExtrudeGeometry(outline, {
        depth: 1.6,
        bevelEnabled: true,
        bevelSize: 0.35,
        bevelThickness: 0.25,
        bevelSegments: 1,
        steps: 1,
      }),
      [mat.grass, mat.earth],
    );
    island.rotation.x = -Math.PI / 2;
    island.position.y = -1.85;
    cylinder(10.8, 6.3, 3.4, mat.rock, 0, -3.2, 0, 7).rotation.y = 0.2;
    const crystal = material('#6ee7cd', { emissive: '#399e88', emissiveIntensity: 0.8 });
    for (const [x, y, z, scale] of [
      [-7, -3, 2, 0.7],
      [6, -2.6, 4, 0.55],
      [1, -4.6, 1, 0.9],
      [4, -3, -5, 0.5],
    ]) {
      const c = mesh(new THREE.OctahedronGeometry(scale, 0), crystal, x, y, z);
      c.scale.y = 2;
    }
    box(18, 0.07, 1.25, mat.road, 0, 0.04, 0);
    box(1.35, 0.07, 13, mat.road, 0, 0.045, 0);
    for (const x of [-5, 5]) {
      box(1.2, 0.07, 5.8, mat.road, x, 0.05, -1.5);
    }
    cylinder(1.55, 1.55, 0.12, mat.cream, 0, 0.13, 0, 20);
    cylinder(1.05, 1.15, 0.35, mat.dark, 0, 0.35, 0, 16);
    cylinder(0.9, 0.9, 0.08, mat.water, 0, 0.56, 0, 20);
    cylinder(0.2, 0.3, 0.9, mat.cream, 0, 0.8, 0);
    cylinder(0.6, 0.55, 0.12, mat.cream, 0, 1.25, 0, 14);
    const fountain = mesh(new THREE.TorusGeometry(0.5, 0.04, 6, 25), mat.teal, 0, 1.36, 0);
    fountain.rotation.x = Math.PI / 2;
    function house(x: number, z: number, wall: string, roof: string, width = 2.65, height = 1.9) {
      const body = material(wall);
      const roofMat = material(roof);
      box(width + 0.25, 0.18, 2.75, mat.cream, x, 0.12, z);
      box(width, height, 2.5, body, x, height / 2 + 0.2, z);
      const top = cylinder(width * 0.78, width * 0.78, 1.1, roofMat, x, height + 0.7, z, 4);
      top.rotation.y = Math.PI / 4;
      top.geometry.dispose();
      top.geometry = new THREE.ConeGeometry(width * 0.86, 1.25, 4);
      top.scale.z = 1.04;
      box(0.68, 1.15, 0.08, mat.dark, x, 0.76, z + 1.29);
      box(0.12, 1.3, 0.12, mat.wood, x - 0.42, 0.83, z + 1.3);
      box(0.12, 1.3, 0.12, mat.wood, x + 0.42, 0.83, z + 1.3);
      for (const offset of [-0.85, 0.85])
        box(0.43, 0.5, 0.09, mat.glow, x + offset, 1.25, z + 1.29);
      box(0.45, 0.85, 0.45, mat.dark, x + 0.75, height + 1.15, z - 0.4);
      return top;
    }
    house(-5, -4, '#d4cbd7', '#756294', 3, 2.25);
    house(5, -4, '#d3b7a0', '#ad7062');
    house(0, -6, '#cfbcb4', '#587e83', 2.5, 1.65);
    house(-5, 3, '#9abcb7', '#4e686e', 2.6, 1.7);
    house(6, 3.3, '#c6c79d', '#b58c58', 2, 1.5);
    cylinder(0.05, 0.05, 2, mat.wood, -5, 3.5, -4, 6);
    box(0.8, 0.5, 0.05, material('#ad97ee'), -4.6, 4.1, -4);
    for (let i = 0; i < 7; i++)
      box(0.4, 0.08, 1, material(i % 2 ? '#eacba9' : '#bd795b'), 3.8 + i * 0.4, 1.5, -2.5);
    for (const x of [3.9, 6.1]) box(0.1, 1.4, 0.1, mat.wood, x, 0.7, -2.1);
    for (const [x, z] of [
      [3.4, -2.8],
      [6.6, -2.6],
      [-6.5, 4.1],
    ]) {
      box(0.65, 0.55, 0.6, mat.wood, x, 0.35, z);
      box(0.67, 0.08, 0.1, mat.dark, x, 0.4, z + 0.3);
    }
    cylinder(0.9, 0.9, 0.12, mat.wood, 2.25, 0.9, -5, 12);
    cylinder(0.08, 0.08, 0.9, mat.wood, 2.25, 0.45, -5, 7);
    const umbrella = mesh(new THREE.ConeGeometry(1.3, 0.55, 8), material('#c79da4'), 2.25, 2.2, -5);
    cylinder(0.04, 0.04, 2.1, mat.wood, 2.25, 1.1, -5);
    for (const x of [1.3, 3.2]) {
      cylinder(0.27, 0.27, 0.12, mat.wood, x, 0.55, -5, 8);
      cylinder(0.05, 0.05, 0.5, mat.dark, x, 0.25, -5);
    }
    box(2.6, 0.12, 2.7, material('#6c5744'), 5.2, 0.12, 5.8);
    for (let x = 0; x < 4; x++)
      for (let z = 0; z < 4; z++) {
        cylinder(0.025, 0.025, 0.4, material('#94ac63'), 4.3 + x * 0.55, 0.4, 4.9 + z * 0.55, 4);
        mesh(
          new THREE.OctahedronGeometry(0.13),
          material('#d7bd67'),
          4.3 + x * 0.55,
          0.65,
          4.9 + z * 0.55,
        );
      }
    for (const [x, z] of [
      [-8, -6],
      [-8, -2],
      [8.2, -6.6],
      [8.6, 0.5],
      [-8, 5.7],
      [-3.3, 6.4],
      [3.1, 7],
      [-3, -7],
    ]) {
      cylinder(0.17, 0.24, 1.6, mat.wood, x, 0.8, z);
      const tree = mesh(new THREE.DodecahedronGeometry(0.95, 0), material('#578b6d'), x, 2, z);
      tree.scale.y = 1.3;
      mesh(new THREE.DodecahedronGeometry(0.65, 0), material('#72a584'), x + 0.22, 2.8, z);
    }
    cylinder(1.1, 1.2, 0.12, mat.water, 0, 0.12, 5.2, 16);
    mesh(new THREE.DodecahedronGeometry(0.4), mat.cream, -1.15, 0.23, 5);
    box(1.5, 0.1, 0.5, mat.wood, -1.7, 0.65, 3.8);
    for (const x of [-2.2, -1.2]) box(0.12, 0.65, 0.35, mat.wood, x, 0.3, 3.8);
    for (const [x, z] of [
      [-2.1, -2],
      [2, 1.9],
      [-7.4, 0.6],
      [7.7, -2],
      [1.4, 4.3],
    ]) {
      cylinder(0.06, 0.08, 1.6, mat.dark, x, 0.85, z);
      box(0.34, 0.45, 0.34, mat.glow, x, 1.72, z);
      const cap = mesh(new THREE.ConeGeometry(0.3, 0.2, 4), mat.dark, x, 2.02, z);
      cap.rotation.y = Math.PI / 4;
    }
    for (let i = 0; i < 12; i++) {
      for (const z of [-8, 8]) {
        const x = -7.8 + i * 1.4;
        box(0.1, 0.65, 0.1, mat.wood, x, 0.35, z);
        if (i < 11) box(1.4, 0.08, 0.08, mat.wood, x + 0.7, 0.5, z);
      }
    }
    const actors = new Map<
      AgentId,
      { group: THREE.Group; ring: THREE.Mesh; goal: string; path: THREE.Vector3[]; index: number }
    >();
    function avatar(color: string, id: string) {
      const group = new THREE.Group();
      const shirt = material(color);
      const skin = material('#e8c6a5');
      box(0.42, 0.46, 0.28, shirt, 0, 0.62, 0, group);
      mesh(new THREE.SphereGeometry(0.245, 12, 8), skin, 0, 1.02, 0, group);
      for (const x of [-0.13, 0.13]) {
        box(0.13, 0.3, 0.14, mat.dark, x, 0.24, 0, group);
        box(0.14, 0.09, 0.25, mat.dark, x, 0.08, 0.05, group);
        box(0.1, 0.4, 0.12, shirt, x * 2.2, 0.59, 0, group);
        mesh(new THREE.SphereGeometry(0.035, 6, 6), mat.dark, x * 0.65, 1.03, 0.22, group);
      }
      cylinder(
        0.27,
        0.25,
        0.12,
        material(id === 'lin' ? '#cfb272' : '#39434d'),
        0,
        1.22,
        0,
        10,
        group,
      );
      if (id === 'mira') {
        cylinder(0.26, 0.25, 0.16, material('#edc66d'), 0, 1.32, 0, 8, group);
        for (const x of [-0.17, 0, 0.17])
          mesh(new THREE.ConeGeometry(0.06, 0.18, 4), material('#edc66d'), x, 1.48, 0, group);
      }
      if (id === 'ada')
        mesh(
          new THREE.SphereGeometry(0.27, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
          material('#d6b36d'),
          0,
          1.22,
          0,
          group,
        );
      if (id === 'otto') box(0.27, 0.32, 0.12, mat.wood, 0, 0.65, -0.23, group);
      return group;
    }
    function destination(id: AgentId, location: string) {
      const p = places[location as keyof typeof places];
      const i = profiles.findIndex((a) => a.id === id);
      const angle = (i / 6) * Math.PI * 2;
      return new THREE.Vector3(
        p.x + Math.cos(angle) * 0.8,
        0,
        p.z + (location === 'square' ? Math.sin(angle) * 1.7 : 1.8 + Math.sin(angle) * 0.65),
      );
    }
    for (const [i, p] of profiles.entries()) {
      const g = avatar(p.color, p.id);
      const a = latest.current.world.agents.find((x) => x.id === p.id)!;
      g.position.copy(destination(p.id, a.location));
      scene.add(g);
      const ring = mesh(
        new THREE.TorusGeometry(0.43, 0.025, 5, 24),
        material(p.color, { emissive: p.color, emissiveIntensity: 0.7 }),
        0,
        0.06,
        0,
        g,
      );
      ring.rotation.x = Math.PI / 2;
      actors.set(p.id, { group: g, ring, goal: a.location, path: [], index: i });
    }
    const human = avatar('#ffffff', 'human');
    human.position.set(1.8, 0, 0.8);
    scene.add(human);
    const stars = new Float32Array(250 * 3);
    for (let i = 0; i < 250; i++) {
      stars[i * 3] = Math.sin(i * 127.1) * 38;
      stars[i * 3 + 1] = 10 + Math.abs(Math.sin(i * 63.7)) * 25;
      stars[i * 3 + 2] = Math.cos(i * 77.3) * 38;
    }
    const starsGeo = new THREE.BufferGeometry();
    starsGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    scene.add(
      new THREE.Points(
        starsGeo,
        new THREE.PointsMaterial({
          color: '#b3dcd8',
          size: 0.055,
          transparent: true,
          opacity: 0.75,
        }),
      ),
    );
    const drops = new Float32Array(140 * 3);
    for (let i = 0; i < 140; i++) {
      drops[i * 3] = Math.sin(i * 14.6) * 11;
      drops[i * 3 + 1] = (i % 15) + 2;
      drops[i * 3 + 2] = Math.cos(i * 9.6) * 9;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(drops, 3));
    const rain = new THREE.Points(
      rainGeo,
      new THREE.PointsMaterial({ color: '#a9def6', size: 0.095, transparent: true, opacity: 0.85 }),
    );
    scene.add(rain);
    let width = 1,
      height = 1;
    const observer = new ResizeObserver(() => {
      width = element.clientWidth;
      height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.zoom = Math.min(1, width / height / 1.55);
      camera.updateProjectionMatrix();
    });
    observer.observe(element);
    let frame = 0;
    let last = performance.now();
    const v = new THREE.Vector3();
    function render(now: number) {
      frame = requestAnimationFrame(render);
      if (document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const state = latest.current;
      ambient.intensity = state.night ? 1.0 : 1.75;
      sun.intensity = state.night ? 2 : 3;
      rim.intensity = state.night ? 1.3 : 0.7;
      human.visible = state.world.human;
      rain.visible = hasEffect(state.world, 'rain');
      if (rain.visible && !reduceMotion) {
        for (let i = 0; i < drops.length / 3; i++) {
          drops[i * 3 + 1] -= dt * 4;
          if (drops[i * 3 + 1] < 0.2) drops[i * 3 + 1] = 13;
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      controls.update();
      camera.updateMatrixWorld();
      const occupied: { x: number; y: number }[] = [];
      for (const a of state.world.agents) {
        const actor = actors.get(a.id)!;
        if (actor.goal !== a.location) {
          const dest = destination(a.id, a.location);
          actor.path = [
            new THREE.Vector3(actor.group.position.x, 0, 0),
            new THREE.Vector3(dest.x, 0, 0),
            dest,
          ];
          actor.goal = a.location;
        }
        const target = actor.path[0];
        let moving = false;
        if (target) {
          const direction = target.clone().sub(actor.group.position);
          const distance = direction.length();
          if (distance < 0.12) actor.path.shift();
          else {
            direction.normalize();
            actor.group.position.addScaledVector(direction, Math.min(distance, dt * 2.3));
            actor.group.rotation.y = Math.atan2(direction.x, direction.z);
            moving = true;
          }
        }
        actor.group.position.y =
          moving && !reduceMotion ? Math.abs(Math.sin(now / 160 + actor.index)) * 0.08 : 0;
        actor.ring.visible = state.selected === a.id;
        actor.ring.scale.setScalar(reduceMotion ? 1 : 1 + Math.sin(now / 450) * 0.07);
        const label = labels.current[a.id];
        if (label) {
          v.copy(actor.group.position).y += 1.65;
          v.project(camera);
          let x = Math.max(28, Math.min(width - 28, ((v.x + 1) * width) / 2));
          let y = ((1 - v.y) * height) / 2;
          for (const prev of occupied)
            if (Math.abs(prev.x - x) < 54 && Math.abs(prev.y - y) < 28) y = prev.y + 29;
          occupied.push({ x, y });
          label.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
          label.style.visibility = v.z > 1 || y < 20 || y > height - 15 ? 'hidden' : 'visible';
        }
      }
      if (!reduceMotion) {
        fountain.rotation.z = now / 1800;
        umbrella.rotation.y = Math.sin(now / 6000) * 0.025;
      }
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (mesh.material)
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) =>
            materials.add(m),
          );
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  function fallbackPosition(a: World['agents'][number]) {
    const peers = world.agents.filter((other) => other.location === a.location);
    const index = peers.findIndex((other) => other.id === a.id);
    const dx = peers.length > 1 ? (index % 2 === 0 ? -7 : 7) : 0;
    const dy =
      peers.length > 1 ? (Math.floor(index / 2) - (Math.ceil(peers.length / 2) - 1) / 2) * 9 : 0;
    return {
      left: `${50 + (places[a.location].x - places[a.location].z) * 2 + dx}%`,
      top: `${47 + (places[a.location].x + places[a.location].z) * 1.5 + dy}%`,
    };
  }
  return (
    <div
      className="town-canvas"
      ref={host}
      data-renderer={fallback ? 'fallback' : 'webgl'}
      aria-label="星落镇交互地图"
    >
      {fallback && <div className="fallback-note">当前设备使用轻量地图</div>}
      <div className={`map-label-layer ${fallback ? 'fallback-layer' : ''}`}>
        {fallback && (
          <svg className="fallback-map" viewBox="0 0 800 600" aria-hidden="true">
            <path
              d="m60 280 350-190 340 190-350 200z"
              fill="#304d48"
              stroke="#81c9af"
              strokeWidth="2"
            />
            <path
              d="m80 280 320 180 330-180M400 100v350"
              fill="none"
              stroke="#76918b"
              strokeWidth="16"
            />
            {Object.entries(places)
              .filter(([id]) => id !== 'square')
              .map(([id, p]) => (
                <g
                  key={id}
                  transform={`translate(${400 + (p.x - p.z) * 16},${275 + (p.x + p.z) * 9})`}
                >
                  <rect x="-22" y="-35" width="44" height="35" fill="#b2c6ba" />
                  <path d="m-28-35 28-23 28 23z" fill="#9e88ab" />
                  <text y="20" textAnchor="middle" fill="#b9cdc5" fontSize="11">
                    {p.name}
                  </text>
                </g>
              ))}
          </svg>
        )}
        {world.agents.map((a) => (
          <button
            key={a.id}
            ref={(el) => {
              labels.current[a.id] = el;
            }}
            className={`map-agent ${selected === a.id ? 'selected' : ''}`}
            style={
              {
                '--agent': a.color,
                ...(fallback ? fallbackPosition(a) : {}),
              } as React.CSSProperties
            }
            onClick={() => onSelect(a.id)}
            aria-label={`查看${a.name}`}
          >
            <i />
            {a.name}
            {selected === a.id && <span className="following-dot" />}
          </button>
        ))}
      </div>
    </div>
  );
}
