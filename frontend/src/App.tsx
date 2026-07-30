/* global google */
/// <reference types="@types/google.maps" />

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';
import OpenRouteService from 'openrouteservice-js';
import { decode, decodeAudioData, createBlob } from './utils/audio';
import { NavigationStatus, Location } from './types';

const FRAME_RATE = 2; 
const JPEG_QUALITY = 0.4;
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025'; 
const TTS_MODEL_NAME = 'gemini-2.5-flash-preview-tts';
const AGENT_VOICE = 'Kore';

// Tool Definitions for Google Maps Integration
const searchPlaceTool: FunctionDeclaration = {
  name: 'search_place',
  parameters: {
    type: Type.OBJECT,
    description: 'Search for a place or business. Use this to find specific names or categories like "mall", "pharmacy", or "Evolve Concept Mall". It prioritizes results closest to the user.',
    properties: {
      query: { type: Type.STRING, description: 'The place name or category (e.g., "Starbucks", "mall").' },
      rankByDistance: { type: Type.BOOLEAN, description: 'Whether to strictly rank results by distance. Set to true if the user asks for the "closest" or "nearest" something.' }
    },
    required: ['query'],
  },
};

const getDirectionsTool: FunctionDeclaration = {
  name: 'get_directions',
  parameters: {
    type: Type.OBJECT,
    description: 'Start walking navigation to a destination. Call this IMMEDIATELY when the user mentions a place, address, or business they want to go to. Do NOT ask for confirmation first.',
    properties: {
      destination: { type: Type.STRING, description: 'The name, address, or category of the destination (e.g., "Starbucks", "123 Main St", "nearest park").' }
    },
    required: ['destination'],
  },
};

const adjustZoomTool: FunctionDeclaration = {
  name: 'adjust_zoom',
  parameters: {
    type: Type.OBJECT,
    description: 'Adjust the map zoom level.',
    properties: {
      direction: { type: Type.STRING, enum: ['in', 'out'], description: 'Whether to zoom in for more detail or out for a broader view.' }
    },
    required: ['direction'],
  },
};

const getNavigationStatusTool: FunctionDeclaration = {
  name: 'get_navigation_status',
  parameters: {
    type: Type.OBJECT,
    description: 'Get the current navigation status, including the next steps and remaining distance.',
    properties: {},
  },
};

const reverseGeocodeTool: FunctionDeclaration = {
  name: 'get_current_address',
  parameters: {
    type: Type.OBJECT,
    description: 'Get the physical address of specific coordinates.',
    properties: {
      latitude: { type: Type.NUMBER },
      longitude: { type: Type.NUMBER }
    },
    required: ['latitude', 'longitude'],
  },
};

const getCurrentLocationTool: FunctionDeclaration = {
  name: 'get_my_location',
  parameters: {
    type: Type.OBJECT,
    description: 'Get the users current GPS coordinates (latitude and longitude).',
    properties: {},
  },
};

// Combined tool: search nearest + navigate in ONE call (faster than 2 round-trips)
const findAndNavigateTool: FunctionDeclaration = {
  name: 'find_and_navigate',
  parameters: {
    type: Type.OBJECT,
    description: 'Search for the nearest place AND immediately start navigation to it. Use this for ANY "nearest/closest X" request. It is faster than calling search_place and get_directions separately.',
    properties: {
      query: { type: Type.STRING, description: 'Category or name to search (e.g. "petrol station", "pharmacy", "McDonald\'s").' },
    },
    required: ['query'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<NavigationStatus>(NavigationStatus.IDLE);
  const [location, setLocation] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [lastInstruction, setLastInstruction] = useState<string>("Vision Guide is ready.");
  const [hazardDetected, setHazardDetected] = useState(false);
  const [gpsActive, setGpsActive] = useState(false);
  const [isMapEnlarged, setIsMapEnlarged] = useState(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [backendDetections, setBackendDetections] = useState<any[]>([]);
  const [isNavigating, setIsNavigating] = useState(false);
  
  // States for Dynamic Exploration
  const [zoom, setZoom] = useState(19); 
  const [upcomingSteps, setUpcomingSteps] = useState<string[]>([]);

  // REFS FOR MAPS JAVASCRIPT API
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<google.maps.Map | null>(null);
  const userMarkerRef = useRef<google.maps.Marker | null>(null);
  const directionsRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  
  const nextStepCoordRef = useRef<google.maps.LatLng | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const backendWsRef = useRef<WebSocket | null>(null);
  const backendReconnectTimeoutRef = useRef<number | null>(null);
  const backendReconnectAttemptsRef = useRef<number>(0);
  const lastHazardAlertRef = useRef<number>(0);

  const isLiveRef = useRef(false);
  const isStartingRef = useRef(false);
  const locationRef = useRef<Location | null>(null);
  useEffect(() => {
    isLiveRef.current = isLive;
  }, [isLive]);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(() => {
    if (isLive && sessionRef.current && location) {
      sessionRef.current.sendRealtimeInput({
        text: `[System Update] User current location: ${location.latitude}, ${location.longitude}. Use get_current_address if you need to know the street name.`
      });
    }
  }, [location?.latitude, location?.longitude, isLive]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      const heading = (event as any).webkitCompassHeading || event.alpha;
      if (heading !== null && location) {
        setLocation(prev => prev ? { ...prev, heading } : null);
      }
    };

    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    return () => window.removeEventListener('deviceorientationabsolute', handleOrientation);
  }, [location]);

  // LOGIC FOR DYNAMIC MAP UPDATES
  useEffect(() => {
    if (mapRef.current && location && !googleMapRef.current && typeof google !== 'undefined') {
      googleMapRef.current = new google.maps.Map(mapRef.current, {
        center: { lat: location.latitude, lng: location.longitude },
        zoom: 19,
        heading: location.heading || 0,
        tilt: 45, 
        disableDefaultUI: true,
        gestureHandling: 'greedy',
        styles: [
          { featureType: "all", elementType: "geometry", stylers: [{ color: "#242f3e" }] },
          { featureType: "road", elementType: "geometry", stylers: [{ color: "#4b5563" }] },
          { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1f2937" }, { weight: 1 }] },
          { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#6b7280" }] },
          { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
          { featureType: "all", elementType: "labels.text.fill", stylers: [{ color: "#9ca3af" }] },
        ]
      });

      directionsRendererRef.current = new google.maps.DirectionsRenderer({
        map: googleMapRef.current,
        suppressMarkers: false,
        polylineOptions: {
          strokeColor: "#FAFF00",
          strokeWeight: 8,
          strokeOpacity: 0.8
        }
      });

      userMarkerRef.current = new google.maps.Marker({
        position: { lat: location.latitude, lng: location.longitude },
        map: googleMapRef.current,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 7,
          fillColor: "#FACC15",
          fillOpacity: 1,
          strokeColor: "#000000",
          strokeWeight: 2,
          rotation: location.heading || 0
        },
        zIndex: 1000
      });

      googleMapRef.current.addListener('dragstart', () => {
        setIsFollowing(false);
      });
    }

    if (googleMapRef.current && location) {
      if (userMarkerRef.current) {
        userMarkerRef.current.setPosition({ lat: location.latitude, lng: location.longitude });
        if (location.heading !== undefined && location.heading !== null) {
          const icon = userMarkerRef.current.getIcon() as google.maps.Symbol;
          if (icon) {
            icon.rotation = location.heading;
            userMarkerRef.current.setIcon(icon);
          }
        }
      }

      if (isFollowing) {
        googleMapRef.current.panTo({ lat: location.latitude, lng: location.longitude });
        if (googleMapRef.current.getZoom() !== zoom) {
          googleMapRef.current.setZoom(zoom);
        }
        if (location.heading !== undefined && location.heading !== null) {
          googleMapRef.current.setHeading(location.heading);
        }
      }
    }
  }, [location, zoom, isFollowing, hasInteracted]);

  // Handle Route Drawing
  useEffect(() => {
    if (location && nextStepCoordRef.current && typeof google !== 'undefined') {
      const userPos = new google.maps.LatLng(location.latitude, location.longitude);
      const distance = google.maps.geometry.spherical.computeDistanceBetween(userPos, nextStepCoordRef.current);
      
      if (distance < 5) {
        speakWithAgentVoice("You are approaching your next turn.");
        nextStepCoordRef.current = null;
      }
    }
  }, [location]);

  const adjustZoom = useCallback((direction: 'in' | 'out') => {
    setZoom(prev => {
      const newZoom = direction === 'in' ? prev + 1 : prev - 1;
      return Math.min(Math.max(newZoom, 12), 21);
    });
  }, []);

  const requestLocation = useCallback(() => {
    if (navigator.geolocation) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }

      const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
      const success = (pos: GeolocationPosition) => {
        setLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          heading: pos.coords.heading ?? undefined
        });
        setGpsActive(true);
        setError(null);
      };
      const errCb = (err: GeolocationPositionError) => {
        setGpsActive(false);
        if (err.code === err.PERMISSION_DENIED) {
          setError("GPS permission denied. Enable location access for this site in your browser settings.");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setError("GPS position unavailable. Check that location services are enabled on your device.");
        } else if (err.code === err.TIMEOUT) {
          setError("GPS signal timed out. Move to an open area and try again.");
        }
      };

      navigator.geolocation.getCurrentPosition(success, errCb, options);
      watchIdRef.current = navigator.geolocation.watchPosition(success, errCb, options);
    }
  }, []);

  const playSystemSound = useCallback((type: 'alert' | 'activate') => {
    if (!audioContextOutRef.current) {
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    const ctx = audioContextOutRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    if (type === 'alert') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, ctx.currentTime); 
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        setHazardDetected(true);
        setTimeout(() => setHazardDetected(false), 800);
    } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); 
        osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.2); 
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    }

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (type === 'alert' ? 0.2 : 0.6));
  }, []);

  const speakWithAgentVoice = async (text: string) => {
    try {
      const genAI = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const response = await genAI.models.generateContent({
        model: TTS_MODEL_NAME,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: AGENT_VOICE } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const ctx = audioContextOutRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        if (ctx.state === 'suspended') await ctx.resume();
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.start();
      }
    } catch (e) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }
  };

  const handleSearchPlace = (query: string, rankByDistance: boolean = false) => {
    return new Promise((resolve) => {
      if (typeof google === 'undefined') {
        resolve({ error: "Google Maps SDK not loaded yet." });
        return;
      }
      const service = new google.maps.places.PlacesService(document.createElement('div'));
      const currentLocation = locationRef.current;
      const userLatLng = currentLocation ? new google.maps.LatLng(currentLocation.latitude, currentLocation.longitude) : undefined;

      if (rankByDistance && userLatLng) {
        const request: google.maps.places.PlaceSearchRequest = {
          location: userLatLng,
          rankBy: google.maps.places.RankBy.DISTANCE,
          keyword: query
        };
        service.nearbySearch(request, (results: any, status: any) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && results) {
            resolve(results.slice(0, 5).map((r: any) => {
              const dist = google.maps.geometry.spherical.computeDistanceBetween(userLatLng, r.geometry.location);
              return {
                name: r.name,
                address: r.vicinity || r.formatted_address,
                place_id: r.place_id,
                distance_meters: Math.round(dist),
                is_walkable_estimate: dist < 2000
              };
            }));
          } else {
            resolve({ error: "No nearby places found for this keyword." });
          }
        });
      } else {
        const request = {
          query,
          location: userLatLng,
          radius: 5000
        };
        service.textSearch(request, (results: any, status: any) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && results) {
            resolve(results.slice(0, 5).map((r: any) => {
              let distInfo = {};
              if (userLatLng && r.geometry?.location) {
                const dist = google.maps.geometry.spherical.computeDistanceBetween(userLatLng, r.geometry.location);
                distInfo = { 
                  distance_meters: Math.round(dist),
                  is_walkable_estimate: dist < 2000
                };
              }
              return {
                name: r.name,
                address: r.formatted_address,
                place_id: r.place_id,
                ...distInfo
              };
            }));
          } else {
            resolve({ error: "No places found for this query." });
          }
        });
      }
    });
  };

  const handleGetDirections = async (destination: string) => {
    if (typeof google === 'undefined') {
      return { error: "SDK not loaded." };
    }
    const location = locationRef.current;
    if (!location) {
      return { error: "GPS location not available yet. Please wait for a signal." };
    }

    const orsKey = (import.meta as any).env.VITE_ORS_API_KEY;

    if (!orsKey) {
      return new Promise((resolve) => {
        const directionsService = new google.maps.DirectionsService();
        const request = {
          origin: new google.maps.LatLng(location.latitude, location.longitude),
          destination: destination,
          travelMode: google.maps.TravelMode.WALKING
        };
        directionsService.route(request, (result: any, status: any) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            if (directionsRendererRef.current) {
              directionsRendererRef.current.setDirections(result);
            }
            const route = result.routes[0];
            const leg = route.legs[0];
            const steps = leg.steps.map((s: any) => s.instructions.replace(/<[^>]*>?/gm, ''));
            setUpcomingSteps(steps);
            setIsNavigating(true);
            resolve({
              steps: steps,
              total_distance: leg.distance?.text,
              total_duration: leg.duration?.text,
              provider: "Google Maps (Fallback)"
            });
          } else {
            resolve({ error: "Could not find a walking route with Google Maps." });
          }
        });
      });
    }

    try {
      const geocoder = new google.maps.Geocoder();
      const geocodeResult: any = await new Promise((res) => {
        geocoder.geocode({ address: destination }, (results, status) => {
          if (status === "OK" && results?.[0]) res(results[0]);
          else res(null);
        });
      });

      if (!geocodeResult) {
        return { error: "Could not find the destination address." };
      }

      const destLat = geocodeResult.geometry.location.lat();
      const destLng = geocodeResult.geometry.location.lng();

      const orsDirections = new OpenRouteService.Directions({ api_key: orsKey });

      const response = await orsDirections.calculate({
        coordinates: [[location.longitude, location.latitude], [destLng, destLat]],
        profile: 'foot-walking',
        format: 'geojson'
      });

      if (response.features && response.features.length > 0) {
        const feature = response.features[0];
        const coords = feature.geometry.coordinates;
        const googleCoords = coords.map((c: any) => ({ lat: c[1], lng: c[0] }));

        if (directionsRendererRef.current) directionsRendererRef.current.setDirections({ routes: [] } as any);
        if (polylineRef.current) polylineRef.current.setMap(null);

        polylineRef.current = new google.maps.Polyline({
          path: googleCoords,
          geodesic: true,
          strokeColor: '#FAFF00',
          strokeOpacity: 0.8,
          strokeWeight: 8,
          map: googleMapRef.current
        });

        const segments = feature.properties.segments[0];
        const steps = segments.steps.map((s: any) => s.instruction);
        setUpcomingSteps(steps);
        setIsNavigating(true);

        if (googleCoords.length > 1) {
          nextStepCoordRef.current = new google.maps.LatLng(googleCoords[1].lat, googleCoords[1].lng);
        }

        return {
          steps: steps,
          total_distance: `${(segments.distance / 1000).toFixed(2)} km`,
          total_duration: `${Math.round(segments.duration / 60)} mins`,
          provider: "OpenRouteService SDK"
        };
      } else {
        return { error: "OpenRouteService SDK could not find a walking route." };
      }
    } catch (err: any) {
      console.error("Navigation Error:", err);
      return { error: `Navigation failed: ${err.message || 'Unknown error'}` };
    }
  };

  // Combined: nearest search + navigate in one step (avoids double round-trip latency)
  const handleFindAndNavigate = async (query: string) => {
    const location = locationRef.current;
    if (!location) return { error: "GPS not available yet." };
    if (typeof google === 'undefined') return { error: "Maps SDK not loaded." };

    // Step 1: nearbySearch ranked by distance
    const userLatLng = new google.maps.LatLng(location.latitude, location.longitude);
    const service = new google.maps.places.PlacesService(document.createElement('div'));

    const nearestPlace: any = await new Promise((resolve) => {
      service.nearbySearch(
        { location: userLatLng, rankBy: google.maps.places.RankBy.DISTANCE, keyword: query },
        (results: any, status: any) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && results?.length) {
            const r = results[0];
            const dist = google.maps.geometry.spherical.computeDistanceBetween(userLatLng, r.geometry.location);
            resolve({ name: r.name, address: r.vicinity || r.name, distance_meters: Math.round(dist) });
          } else {
            resolve(null);
          }
        }
      );
    });

    if (!nearestPlace) {
      return { error: `Could not find any nearby ${query}. Try a different search term.` };
    }

    // Step 2: immediately get directions (reuse existing logic)
    const directionsResult = await handleGetDirections(nearestPlace.address || nearestPlace.name);
    return {
      found: nearestPlace.name,
      distance_meters: nearestPlace.distance_meters,
      navigation: directionsResult
    };
  };

  // Cancel navigation - clears route without disconnecting
  const cancelNavigation = useCallback(() => {
    setUpcomingSteps([]);
    setIsNavigating(false);
    nextStepCoordRef.current = null;

   if (directionsRendererRef.current) {
    directionsRendererRef.current.setMap(null);
    }

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    // Tell agent navigation was cancelled
    if (sessionRef.current && isLiveRef.current) {
      sessionRef.current.sendRealtimeInput({
        text: "[System Update] Navigation has been cancelled by the user. Ask them where they would like to go next."
      });
    }
    speakWithAgentVoice("Navigation cancelled.");
  }, []);

  const handleReverseGeocode = (lat: number, lng: number) => {
    return new Promise((resolve) => {
      if (typeof google === 'undefined') {
        resolve({ error: "SDK not loaded." });
        return;
      }
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === "OK" && results?.[0]) {
          resolve({ address: results[0].formatted_address });
        } else {
          resolve({ error: "Could not determine address." });
        }
      });
    });
  };

  const handleGetCurrentLocation = () => {
    const location = locationRef.current;
    if (location) {
      return { latitude: location.latitude, longitude: location.longitude };
    }
    return { error: "GPS signal not found yet. Please wait." };
  };

  const connectBackendWs = useCallback(() => {
    if (!isLiveRef.current) return;

    const ws = new WebSocket(import.meta.env.VITE_BACKEND_WS_URL);
    ws.onopen = () => {
      console.log("Connected to backend vision service");
      backendReconnectAttemptsRef.current = 0;
    };
    ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.status === 'success') {
        setBackendDetections(data.detections || []);
        if (data.hazard) {
            playSystemSound('alert');
            setHazardDetected(true);
            setTimeout(() => setHazardDetected(false), 500);

            const now = Date.now();
            if (
                sessionRef.current &&
                isLiveRef.current &&
                data.detections?.length > 0 &&
                now - lastHazardAlertRef.current > 3000
            ) {
                lastHazardAlertRef.current = now;
                const labels = data.detections
                    .map((d: any) => `${d.label} ${d.distance ? `(${d.distance})` : ''}`.trim())
                    .join(', ');
                sessionRef.current.sendRealtimeInput({
                    text: `[System Update] Camera detected hazard ahead: ${labels}. Warn the user immediately with a short, urgent phrase naming what it is.`
                });
            }
        }
    } else {
        console.error("Backend detection error:", data.message || data);
    }
    };
    ws.onerror = (e) => console.error("Backend WebSocket error", e);
    ws.onclose = () => {
      if (isLiveRef.current && backendReconnectAttemptsRef.current < 10) {
        backendReconnectAttemptsRef.current += 1;
        console.log(`Backend WebSocket closed, retrying (${backendReconnectAttemptsRef.current}/10) in 2s...`);
        backendReconnectTimeoutRef.current = window.setTimeout(() => connectBackendWs(), 2000);
      }
    };
    backendWsRef.current = ws;
  }, []);

  const stopSession = useCallback(() => {
    if (!isLiveRef.current) return;
    playSystemSound('activate');
    setIsLive(false);
    isLiveRef.current = false;
    isStartingRef.current = false;
    setStatus(NavigationStatus.IDLE);
    setLastInstruction("Vision Guide Disconnected.");
    setUpcomingSteps([]);
    setIsNavigating(false);
    setIsProcessing(false);
    nextStartTimeRef.current = 0;
    if (sessionRef.current) sessionRef.current.close?.();
    if (backendReconnectTimeoutRef.current) {
        window.clearTimeout(backendReconnectTimeoutRef.current);
        backendReconnectTimeoutRef.current = null;
    }
    if (backendWsRef.current) {
        backendWsRef.current.close();
        backendWsRef.current = null;
    }
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    if (videoRef.current?.srcObject) (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    
    googleMapRef.current = null;
    userMarkerRef.current = null;
    directionsRendererRef.current = null;
    if (polylineRef.current) polylineRef.current.setMap(null);
    polylineRef.current = null;

    speakWithAgentVoice("Navigation disconnected.");
    setHasInteracted(false);
  }, [playSystemSound]);

  const startSession = useCallback(async () => {
    if (isLiveRef.current || isStartingRef.current) return;
    isStartingRef.current = true;
    setHasInteracted(true);
    playSystemSound('activate');
    requestLocation();

    try {
      setStatus(NavigationStatus.INITIALIZING);
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } 
      });

      if (videoRef.current) videoRef.current.srcObject = stream;
      
      const genAI = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
      const sessionPromise = genAI.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            isStartingRef.current = false;
            setIsLive(true);
            isLiveRef.current = true;
            setStatus(NavigationStatus.ACTIVE);
            
            sessionPromise.then((s: any) => {
              s.sendRealtimeInput({ 
                text: "The session has started. Greet the user very briefly (one sentence max) and immediately ask 'Where would you like to go?'" 
              });
            });

            const audioIn = audioContextInRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            audioContextInRef.current = audioIn;
            if (audioIn.state === 'suspended') audioIn.resume();

            const source = audioIn.createMediaStreamSource(stream);
            const scriptProcessor = audioIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isLiveRef.current) {
                const data = e.inputBuffer.getChannelData(0);
                sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(data) }));
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioIn.destination);

            connectBackendWs();

            frameIntervalRef.current = window.setInterval(() => {
              if (videoRef.current && canvasRef.current && isLiveRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                if (ctx && videoRef.current.videoWidth > 0) {
                  canvasRef.current.width = 640; canvasRef.current.height = 480;
                  ctx.drawImage(videoRef.current, 0, 0, 640, 480);
                  canvasRef.current.toBlob(b => {
                    if (b) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64 = (reader.result as string).split(',')[1];
                        sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                        if (backendWsRef.current && backendWsRef.current.readyState === WebSocket.OPEN) {
                            backendWsRef.current.send(JSON.stringify({ image: base64 }));
                        }
                      };
                      reader.readAsDataURL(b);
                    }
                  }, 'image/jpeg', JPEG_QUALITY);
                }
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (msg) => {
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              const ctx = audioContextOutRef.current;
              if (ctx) {
                nextStartTimeRef.current = ctx.currentTime;
              }
            }

            if (msg.serverContent?.modelTurn) {
              setIsProcessing(false);
            }

            if (msg.serverContent?.inputTranscription?.text) {
              const transcript = msg.serverContent.inputTranscription.text.toLowerCase().trim();
              const cleanTranscript = transcript.replace(/[.,!?;:]/g, '').trim();
              
              // Stop / disconnect commands
              if (
                cleanTranscript === 'stop' || 
                cleanTranscript === 'quit' || 
                cleanTranscript === 'exit' || 
                cleanTranscript === 'disconnect'
              ) {
                stopSession();
                return;
              }

              // Cancel navigation commands (without disconnecting)
              if (
                cleanTranscript === 'cancel' ||
                cleanTranscript === 'cancel navigation' ||
                cleanTranscript === 'stop navigation' ||
                cleanTranscript === 'cancel route' ||
                cleanTranscript === 'stop route' ||
                cleanTranscript.includes('cancel navigation') ||
                cleanTranscript.includes('stop navigating') ||
                cleanTranscript.includes('cancel the route')
              ) {
                cancelNavigation();
                return;
              }

              setIsProcessing(true);
              setTimeout(() => setIsProcessing(false), 15000);
            }

            if (msg.toolCall?.functionCalls) {
              setIsProcessing(true);
              const responses = [];
              try {
                for (const fc of msg.toolCall.functionCalls) {
                  const args: any = fc.args;
                  let res;
                  if (fc.name === 'search_place') {
                    res = await handleSearchPlace(args.query, args.rankByDistance);
                  } else if (fc.name === 'find_and_navigate') {
                    res = await handleFindAndNavigate(args.query);
                  } else if (fc.name === 'get_directions') {
                    res = await handleGetDirections(args.destination);
                  } else if (fc.name === 'get_current_address') {
                    res = await handleReverseGeocode(args.latitude, args.longitude);
                  } else if (fc.name === 'get_my_location') {
                    res = handleGetCurrentLocation();
                  } else if (fc.name === 'adjust_zoom') {
                    adjustZoom(args.direction);
                    res = { status: `Zoomed ${args.direction}` };
                  } else if (fc.name === 'get_navigation_status') {
                    res = { 
                      active_route: upcomingSteps.length > 0,
                      next_step: upcomingSteps[0] || "No active route",
                      remaining_steps_count: upcomingSteps.length
                    };
                  }
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: res }
                  });
                }
                const session = await sessionPromise;
                await session.sendToolResponse({ functionResponses: responses });
              } catch (err) {
                console.error("Tool execution error:", err);
              } finally {
                setIsProcessing(false);
              }
            }

            const base64 = msg.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (base64 && isLiveRef.current) {
              const ctx = audioContextOutRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
              audioContextOutRef.current = ctx;
              if (ctx.state === 'suspended') ctx.resume();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buf = await decodeAudioData(decode(base64), ctx, 24000, 1);
              const src = ctx.createBufferSource();
              src.buffer = buf; src.connect(ctx.destination);
              src.onended = () => sourcesRef.current.delete(src);
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buf.duration;
              sourcesRef.current.add(src);
            }

            const text = msg.serverContent?.modelTurn?.parts?.find(p => p.text)?.text || "";
            if (text && isLiveRef.current) {
              setLastInstruction(text);
              if (/(stop|watch out|careful|hazard|danger|pole|person|stair|curb)/i.test(text)) playSystemSound('alert');
            }
          },
          onerror: (e: any) => {
            console.error("Gemini Live session error:", e);
            stopSession();
          },
          onclose: (e: any) => {
            console.error("Gemini Live session closed:", e?.code, e?.reason, e);
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: AGENT_VOICE } } },
          tools: [{ functionDeclarations: [searchPlaceTool, getDirectionsTool, findAndNavigateTool, reverseGeocodeTool, getCurrentLocationTool, adjustZoomTool, getNavigationStatusTool] }],
          inputAudioTranscription: {}, 
          systemInstruction: `You are VisionGuide AI, a real-time navigation assistant for the visually impaired. Be concise and action-oriented. Your #1 priority is speed — act first, explain briefly after.

DECISION TREE (follow exactly):
- User says "nearest/closest X" → call find_and_navigate immediately. Do not call search_place first. Do not ask for confirmation.
- User says "go to [specific place name or address]" → call get_directions immediately.
- User asks "where am I" → call get_current_address with current coordinates.
- User says "cancel navigation" / "cancel route" → confirm cancelled, ask where next.
- User says "stop" → disconnect.

SPEED RULES:
- Never say "Let me search for that" or "I'll find directions now" — just call the tool silently and report the result.
- Keep ALL spoken responses under 2 sentences unless reading turn-by-turn steps.
- Never ask "Would you like me to navigate there?" — just do it.

NAVIGATION:
- Once route starts, read the first step immediately: distance + direction + landmark.
- When giving steps, say street names. Not "turn left" but "turn left onto Jalan Ampang".
- Warn distance: under 500m = "just X meters away", 500m-2km = "about X minute walk", over 2km = warn user it's far.

SAFETY:
- Camera hazards: use short sharp phrases — "Step ahead", "Obstacle on left", "Car crossing".
- Trigger on: poles, kerbs, stairs, vehicles, people blocking path.

GPS: ${location ? `${location.latitude},${location.longitude}` : 'Unknown — call get_my_location first'}.`,
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message);
      setStatus(NavigationStatus.ERROR);
      stopSession();
    }
  }, [location, playSystemSound, stopSession, cancelNavigation, requestLocation, adjustZoom, upcomingSteps, connectBackendWs]);

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden font-sans select-none">
      {/* Camera thumbnail - top right, only when live */}
      <div className={`absolute top-4 right-4 w-24 h-32 z-50 transition-opacity duration-500 ${isLive ? 'opacity-100' : 'opacity-0'}`}>
        <video ref={videoRef} autoPlay playsInline muted 
          className="w-full h-full object-cover rounded-xl border-2 border-zinc-800"
        />
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
          {backendDetections.map((det, i) => {
            const [x1, y1, x2, y2] = det.box;
            const left = (x1 / 640) * 100;
            const top = (y1 / 480) * 100;
            const width = ((x2 - x1) / 640) * 100;
            const height = ((y2 - y1) / 480) * 100;
            return (
              <div key={i} style={{
                position: 'absolute',
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
                border: '1px solid #22c55e',
                backgroundColor: 'rgba(34, 197, 94, 0.2)'
              }}>
                <span className="text-[6px] text-white bg-green-500 px-0.5 leading-none absolute -top-1 left-0">
                  {det.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Processing indicator - sits above the bottom button bar, never overlaps camera or map overlays */}
      {isLive && isProcessing && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-zinc-900/95 backdrop-blur border border-yellow-400/30 px-4 py-2 rounded-full shadow-lg animate-pulse pointer-events-none">
          <div className="w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] font-black uppercase tracking-widest text-yellow-400">Processing...</span>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />

      {!hasInteracted ? (
        <button 
          onClick={startSession} 
          className="flex-1 flex flex-col items-center justify-center p-8 bg-zinc-950"
          aria-label="Activate Vision Guide Assistant"
        >
          <div className="w-56 h-56 rounded-full border-[8px] border-yellow-400 flex items-center justify-center mb-12" aria-hidden="true">
            <div className="w-20 h-20 bg-yellow-400 rounded-full animate-pulse shadow-[0_0_40px_#facc15]" />
          </div>
          <h1 className="text-5xl font-black text-yellow-400 uppercase tracking-tighter mb-4 text-center">VisionGuide</h1>
          <p className="bg-zinc-900 px-8 py-4 rounded-full border border-zinc-800 font-bold uppercase tracking-widest text-lg shadow-xl active:scale-95 transition-transform">Activate Assistant</p>
          {error && <p className="mt-8 text-red-400 text-xs font-bold uppercase bg-red-950/20 p-3 rounded-xl" role="alert">{error}</p>}
        </button>
      ) : (
        <div className="flex flex-col h-full relative" role="main">
          {/* Screen reader announcements */}
          <div className="sr-only" aria-live="polite">
            {isProcessing && "Processing your request."}
            {!location && !error && "Searching for GPS signal."}
            {location && "GPS signal acquired."}
            {error && error}
            {hazardDetected && "Warning: Hazard detected. Stop immediately."}
          </div>

          {/* Map area */}
          <div className={`transition-all duration-500 ease-in-out bg-zinc-900 overflow-hidden relative ${isMapEnlarged ? 'flex-1' : 'absolute bottom-24 right-4 w-40 h-56 rounded-2xl border-2 border-zinc-800 z-40 shadow-2xl'}`}>
            {location ? (
              <div ref={mapRef} className="w-full h-full" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="font-black uppercase text-zinc-700">Searching GPS...</span>
                {error && (
                  <p className="text-red-400 text-xs font-bold uppercase bg-red-950/20 p-3 rounded-xl" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}

            {/* Next Step Overlay - positioned to avoid camera thumb (top-right) */}
            {upcomingSteps.length > 0 && (
              <div className="absolute top-4 left-4 right-32 z-40" aria-label="Current Navigation Step">
                <div className="bg-black/90 backdrop-blur-xl border-2 border-yellow-400/50 p-3 rounded-2xl shadow-2xl flex items-center gap-3">
                  <div className="w-10 h-10 bg-yellow-400 rounded-xl flex items-center justify-center shrink-0" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-black uppercase tracking-widest text-yellow-400 mb-0.5">Next Step</p>
                    <p className="text-xs font-bold leading-tight text-white line-clamp-2" aria-live="assertive" dangerouslySetInnerHTML={{ __html: upcomingSteps[0] }} />
                  </div>
                </div>
              </div>
            )}
            
            {/* Map Controls */}
            <div className="absolute bottom-4 right-4 flex flex-col gap-2 pointer-events-auto z-40" role="group" aria-label="Map Controls">
              <button 
                onClick={() => {
                  setIsFollowing(true);
                  if (location && googleMapRef.current) {
                    googleMapRef.current.panTo({ lat: location.latitude, lng: location.longitude });
                    googleMapRef.current.setZoom(19);
                  }
                }}
                className={`p-3 rounded-xl shadow-lg active:scale-90 transition-all mb-2 ${isFollowing ? 'bg-yellow-400 text-black' : 'bg-white text-black'}`}
                aria-label="Recenter Map on My Location"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button 
                onClick={() => adjustZoom('in')}
                className="p-3 bg-yellow-400 rounded-xl text-black font-bold shadow-lg active:scale-90 transition-transform"
                aria-label="Zoom In"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button 
                onClick={() => adjustZoom('out')}
                className="p-3 bg-zinc-800 rounded-xl text-white font-bold shadow-lg active:scale-90 transition-transform border border-white/10"
                aria-label="Zoom Out"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
            </div>
            
            {hazardDetected && (
              <div className="absolute inset-0 bg-red-600/60 flex items-center justify-center z-50">
                <div className="bg-red-600 border-4 border-white px-10 py-6 shadow-2xl rounded-2xl animate-bounce">
                  <span className="text-8xl font-black text-white uppercase italic">STOP</span>
                </div>
              </div>
            )}
          </div>

          {!isMapEnlarged && (
            <div className="flex-1 bg-black flex items-center justify-center">
               <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            </div>
          )}

          {/* Bottom controls */}
          <div className="p-4 pb-6 bg-black border-t-2 border-zinc-900 flex justify-center gap-3 z-50">
            {/* Cancel Navigation button - only shown when navigating */}
            {isNavigating && (
              <button 
                onClick={cancelNavigation}
                className="flex-1 max-w-[160px] py-4 bg-zinc-800 rounded-2xl font-black text-yellow-400 uppercase tracking-widest text-sm active:scale-95 border border-yellow-400/30 shadow-lg active:translate-y-1 transition-all"
                aria-label="Cancel current navigation route"
              >
                CANCEL ROUTE
              </button>
            )}
            <button 
              onClick={stopSession} 
              className="flex-1 max-w-[160px] py-4 bg-red-600 rounded-2xl font-black text-white uppercase tracking-widest text-lg active:scale-95 shadow-[0_4px_0_rgb(153,27,27)] active:shadow-none active:translate-y-1 transition-all"
              aria-label="Stop Navigation and Disconnect"
            >
              STOP
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
