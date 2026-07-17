import torch
import cv2
import numpy as np
import base64

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

class depth_obj_det:
    def __init__(self, yolo, midas, transform):
        self._yolo = yolo
        self._midas = midas.to(device)
        self._transform = transform
        self.obstacle_classes = ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'traffic light', 'fire hydrant', 'stop sign', 'dog', 'chair', 'potted plant']

    def cal_depth(self, obj_depth):
        if obj_depth < 0.1:
            distance_label = "Very close"
        elif obj_depth < 0.4:
            distance_label = "Close"
        else:
            distance_label = "Far"
        return distance_label
    
    def process_frame(self, image_bytes):
        has_hazard = False
        detection_info = []
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return {"status": "error", "message": "Failed to decode image"}
        
        results = self._yolo(img, verbose = False)
        detections = results[0].boxes
        img_depth = self._transform(img).to(device)

        with torch.no_grad():
            depth = self._midas(img_depth)
            depth = torch.nn.functional.interpolate(
            depth.unsqueeze(1),
            size=img.shape[:2],
            mode="bicubic",
            align_corners=False,
        ).squeeze()
            
        depth_map = depth.cpu().numpy()
        depth_map = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min())

        for box in detections:
            cls_id = int(box.cls[0])
            label = self._yolo.names[cls_id]
            conf = float(box.conf[0])

            if label not in self.obstacle_classes:
                continue
            
            x1, y1, x2, y2 = map(int, box.xyxy[0])

            object_depth = np.median(depth_map[y1:y2, x1:x2])
            distance_label = self.cal_depth(object_depth)

            if distance_label in ["Very close", "Close"]:
                has_hazard = True

            cv2.rectangle(img, (x1, y1), (x2, y2), (0,255,0), 2)
            cv2.putText(img, f"{label} - {distance_label}",
                        (x1, y1 - 10),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0,255,0),
                        2)
            detection_info.append({
                "label": label,
                "confidence": conf,
                "box": [x1, y1, x2, y2],
                "distance": distance_label
            })
        
        # debug window, uncomment to check object detection
        if has_hazard:
            cv2.putText(img, "HAZARD DETECTED", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 3)

        cv2.namedWindow("Detection Service Feed", cv2.WINDOW_NORMAL)
        cv2.imshow("Detection Service Feed", img)
        cv2.waitKey(1)

        # Encode annotated frame to base64
        _, buffer = cv2.imencode('.jpg', img)
        annotated_frame_base64 = base64.b64encode(buffer).decode('utf-8')

        return {
            "status": "success",
            "detections": detection_info,
            "hazard": has_hazard,
            "annotated_frame": annotated_frame_base64
        }

