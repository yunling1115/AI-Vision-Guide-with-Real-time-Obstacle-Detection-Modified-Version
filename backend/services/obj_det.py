import cv2
import torch
import numpy as np
from ultralytics import YOLO

# Load a small YOLOv8 model (nano)
model = YOLO('yolov8n.pt')

# loading midas model
midas = torch.hub.load("intel-isl/MiDaS", "MiDaS_small", trust_repo=True)
midas.eval()

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
midas.to(device)

transforms = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True)
transform = transforms.small_transform

# COCO classes for common obstacles
OBSTACLE_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 
    'traffic light', 'fire hydrant', 'stop sign', 'dog', 'chair',
    'potted plant'
]

def cal_depth(obj_depth):
    if obj_depth < 0.3:
        distance_label = "Very close"
    elif obj_depth < 0.6:
        distance_label = "Close"
    else:
        distance_label = "Far"
    return distance_label

def process_frame(image_bytes):
    # Convert bytes to numpy array
    nparr = np.frombuffer(image_bytes, np.uint8)
    # Decode image
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        return {"status": "error", "message": "Failed to decode image"}

    # Perform inference
    results = model(img, verbose=False)
    # detections = results[0]
    # img_depth = transform(img).to(device)

    # with torch.no_grad():
    #     depth = midas(img_depth)
    #     depth = torch.nn.functional.interpolate(
    #         depth.unsqueeze(1),
    #         size=img.shape[:2],
    #         mode="bicubic",
    #         align_corners=False,
    #     ).squeeze()
    
    # depth_map = depth.cpu().numpy()
    # depth_map = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min())
    
    detections = []
    has_hazard = False
    
    # Image dimensions
    height, width = img.shape[:2]
    total_area = width * height

    for result in results:
        boxes = result.boxes
        for box in boxes:
            # Class name
            cls_id = int(box.cls[0])
            label = model.names[cls_id]

            if label not in OBSTACLE_CLASSES:
                break
            
            # Confidence
            conf = float(box.conf[0])
            
            if conf < 0.4:  # Threshold
                continue
                
            # Bounding box coordinates (x1, y1, x2, y2)
            coords = box.xyxy[0].tolist()
            x1, y1, x2, y2 = coords

            object_depth = np.median(depth_map[y1:y2, x1:x2])
            distance_label = cal_depth(object_depth)
            
            # Calculate box area and center
            box_width = x2 - x1
            box_height = y2 - y1
            box_area = box_width * box_height
            center_x = (x1 + x2) / 2
            
            # Detection info for frontend
            detections.append({
                "label": label,
                "confidence": conf,
                "box": [x1, y1, x2, y2],
                "distance": distance_label
            })
            
            # Hazard logic: 
            # 1. Object is in the obstacle list
            # 2. Object is relatively large (close) - e.g. > 15% of frame area
            # 3. Or object is in the center path
            
            object_depth = np.median(depth_map[y1:y2, x1:x2])
            dist_label = cal_depth(object_depth)
            # area_ratio = box_area / total_area
            # is_centered = (width * 0.3) < center_x < (width * 0.7)
            
            # if area_ratio > 0.15 or (area_ratio > 0.05 and is_centered):
            if dist_label == "Very close" or dist_label == "Close":
                has_hazard = True

    # Display for debugging (on server side)
    # We can also draw detections on the debug window
    for det in detections:
        b = det["box"]
        cv2.rectangle(img, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), (0, 255, 0), 2)
        cv2.putText(img, f"{det['label']} {det['confidence']:.2f} {det['distance']}", (int(b[0]), int(b[1])-10), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                    
    if has_hazard:
        cv2.putText(img, "HAZARD DETECTED", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 3)

    cv2.namedWindow("Detection Service Feed", cv2.WINDOW_NORMAL)
    cv2.imshow("Detection Service Feed", img)
    cv2.waitKey(1)
        
    return {
        "status": "success", 
        "detections": detections, 
        "hazard": has_hazard
    }
