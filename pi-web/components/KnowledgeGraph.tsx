"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";

export interface GraphEdge {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

interface GraphNode {
  id: string;
  degree: number;
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
}

interface GraphLink {
  id: string;
  source: GraphNode;
  target: GraphNode;
  predicate: string;
}

const VIEW_W = 1000;
const VIEW_H = 640;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

function nodeRadius(degree: number): number {
  return 6 + Math.min(degree, 6) * 2.2;
}

export function KnowledgeGraph({ facts, height }: { facts: GraphEdge[]; height?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [fitted, setFitted] = useState(false);
  const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const { nodeMap } = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const fact of facts) {
      for (const name of [fact.subject, fact.object]) {
        if (!map.has(name)) map.set(name, { id: name, degree: 0, x: 0, y: 0, fx: null, fy: null });
      }
      map.get(fact.subject)!.degree += 1;
      map.get(fact.object)!.degree += 1;
    }
    return { nodeMap: map };
  }, [facts]);

  const startSimulation = useCallback(() => {
    const initialNodes = [...nodeMap.values()].map((node) => ({
      ...node,
      x: VIEW_W / 2 + (Math.random() - 0.5) * VIEW_W * 0.6,
      y: VIEW_H / 2 + (Math.random() - 0.5) * VIEW_H * 0.6,
      fx: null,
      fy: null,
    }));
    const initialLinks: GraphLink[] = facts.map((fact) => ({
      id: fact.id,
      source: initialNodes.find((node) => node.id === fact.subject)!,
      target: initialNodes.find((node) => node.id === fact.object)!,
      predicate: fact.predicate,
    }));

    const simulation = forceSimulation<GraphNode, GraphLink>(initialNodes)
      .force("link", forceLink<GraphNode, GraphLink>(initialLinks).id((node) => node.id).distance(120).strength(0.6))
      .force("charge", forceManyBody<GraphNode>().strength(-420))
      .force("collide", forceCollide<GraphNode>().radius((node) => nodeRadius(node.degree) + 14))
      .force("center", forceCenter(VIEW_W / 2, VIEW_H / 2))
      .alphaDecay(0.028)
      .velocityDecay(0.32);

    simulation.on("tick", () => {
      setNodes([...initialNodes]);
      setLinks([...initialLinks]);
      if (!fitted && simulation.alpha() < 0.12) {
        setFitted(true);
        fitToNodes(initialNodes);
      }
    });

    simulationRef.current?.stop();
    simulationRef.current = simulation;
    setFitted(false);
  }, [nodeMap, facts]);

  const fitToNodes = useCallback((nodeList: GraphNode[]) => {
    if (nodeList.length === 0) return;
    const xs = nodeList.map((node) => node.x);
    const ys = nodeList.map((node) => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 90;
    const width = Math.max(maxX - minX, 60);
    const height = Math.max(maxY - minY, 60);
    const k = Math.min((VIEW_W - pad * 2) / width, (VIEW_H - pad * 2) / height, 1.6);
    setTransform({
      k,
      x: VIEW_W / 2 - ((minX + maxX) / 2) * k,
      y: VIEW_H / 2 - ((minY + maxY) / 2) * k,
    });
  }, []);

  useEffect(() => {
    startSimulation();
    return () => {
      simulationRef.current?.stop();
      simulationRef.current = null;
    };
  }, [startSimulation]);

  const worldFromScreen = useCallback((screenX: number, screenY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const t = transformRef.current;
    return {
      x: (screenX - rect.left - t.x) / t.k,
      y: (screenY - rect.top - t.y) / t.k,
    };
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    const t = transformRef.current;
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0012);
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
    setTransform({
      k,
      x: cursorX - ((cursorX - t.x) / t.k) * k,
      y: cursorY - ((cursorY - t.y) / t.k) * k,
    });
  }, []);

  const panRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const handleBackgroundPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    panRef.current = { startX: event.clientX, startY: event.clientY, baseX: transformRef.current.x, baseY: transformRef.current.y };
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  }, []);

  const handleBackgroundPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setTransform((t) => ({
      ...t,
      x: pan.baseX + (event.clientX - pan.startX),
      y: pan.baseY + (event.clientY - pan.startY),
    }));
  }, []);

  const handleBackgroundPointerUp = useCallback(() => {
    panRef.current = null;
  }, []);

  const dragRef = useRef<{ pointerId: number; node: GraphNode } | null>(null);

  const handleNodePointerDown = useCallback((event: React.PointerEvent<SVGGElement>, node: GraphNode) => {
    event.stopPropagation();
    setSelected(node.id);
    (event.currentTarget as SVGGElement).setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, node };
    const point = worldFromScreen(event.clientX, event.clientY);
    node.fx = point.x;
    node.fy = point.y;
    simulationRef.current?.alphaTarget(0.08).restart();
  }, [worldFromScreen]);

  const handleNodePointerMove = useCallback((event: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = worldFromScreen(event.clientX, event.clientY);
    drag.node.fx = point.x;
    drag.node.fy = point.y;
  }, [worldFromScreen]);

  const handleNodePointerUp = useCallback((event: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    simulationRef.current?.alphaTarget(0);
    (event.currentTarget as SVGGElement).releasePointerCapture(event.pointerId);
  }, []);

  const connectedIds = useMemo(() => {
    if (!hovered && !selected) return new Set<string>();
    const ids = new Set<string>([hovered ?? selected ?? ""]);
    for (const link of links) {
      const sourceId = (link.source as GraphNode).id;
      const targetId = (link.target as GraphNode).id;
      if (sourceId === hovered || sourceId === selected) ids.add(targetId);
      if (targetId === hovered || targetId === selected) ids.add(sourceId);
    }
    return ids;
  }, [hovered, selected, links]);

  const selectedFacts = useMemo(() => {
    if (!selected) return [];
    return facts.filter((fact) => fact.subject === selected || fact.object === selected);
  }, [selected, facts]);

  if (facts.length === 0) {
    return <div className="memory-empty">No graph facts match this search.</div>;
  }

  return (
    <div className="memory-graph" style={height ? { height } : undefined}>
      <div className="memory-graph-toolbar">
        <span className="memory-graph-hint">drag nodes · scroll to zoom · drag background to pan · click a node for details</span>
        <button className="memory-action-btn" onClick={startSimulation}>↻ Relayout</button>
      </div>
      <div className="memory-graph-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          style={{ width: "100%", height: "100%", cursor: panRef.current ? "grabbing" : "grab", touchAction: "none" }}
          onWheel={handleWheel}
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handleBackgroundPointerMove}
          onPointerUp={handleBackgroundPointerUp}
          onClick={() => setSelected(null)}
        >
          <defs>
            <marker id="memory-arrow" viewBox="0 0 10 10" refX="20" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-dim)" />
            </marker>
          </defs>
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {links.map((link) => {
              const source = link.source as GraphNode;
              const target = link.target as GraphNode;
              const active = connectedIds.has(source.id) && connectedIds.has(target.id);
              const dim = (hovered || selected) && !active;
              const midX = (source.x + target.x) / 2;
              const midY = (source.y + target.y) / 2;
              return (
                <g key={link.id}>
                  <line
                    x1={source.x} y1={source.y} x2={target.x} y2={target.y}
                    stroke={active ? "var(--accent)" : "var(--text-dim)"}
                    strokeOpacity={dim ? 0.12 : active ? 0.9 : 0.45}
                    strokeWidth={active ? 1.8 : 1}
                    markerEnd={active ? "url(#memory-arrow)" : undefined}
                    onMouseEnter={() => setHovered(source.id)}
                    onMouseLeave={() => setHovered(null)}
                  />
                  {active && (
                    <text
                      x={midX} y={midY - 6}
                      textAnchor="middle"
                      fontSize={12}
                      fill="var(--accent)"
                      style={{ pointerEvents: "none", fontFamily: "var(--font-mono)" }}
                    >
                      {link.predicate}
                    </text>
                  )}
                </g>
              );
            })}
            {nodes.map((node) => {
              const isHovered = hovered === node.id;
              const isSelected = selected === node.id;
              const dim = (hovered || selected) && !connectedIds.has(node.id);
              const radius = nodeRadius(node.degree);
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onClick={(event) => event.stopPropagation()}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: "grab", opacity: dim ? 0.15 : 1 }}
                >
                  <circle
                    r={radius}
                    fill={isSelected ? "var(--accent)" : isHovered ? "var(--accent)" : "var(--bg-panel)"}
                    stroke={isSelected || isHovered ? "var(--accent)" : "var(--text-muted)"}
                    strokeWidth={isSelected || isHovered ? 2 : 1.2}
                  />
                  <text
                    y={radius + 13}
                    textAnchor="middle"
                    fontSize={node.id.length > 18 ? 10.5 : 12}
                    fill={isHovered || isSelected ? "var(--text)" : "var(--text-dim)"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {node.id}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        {selected && (
          <div className="memory-graph-detail">
            <div className="memory-graph-detail-title">
              <strong>{selected}</strong>
              <button onClick={() => setSelected(null)}>×</button>
            </div>
            {selectedFacts.map((fact) => (
              <div key={fact.id} className="memory-fact">
                <b>{fact.subject}</b>
                <span>{fact.predicate}</span>
                <b>{fact.object}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
