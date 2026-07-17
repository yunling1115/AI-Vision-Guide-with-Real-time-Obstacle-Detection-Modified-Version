"""
Test script for a YOLOv8 .pt model on a live webcam feed.
Useful when you don't have the .yaml file and don't know what classes
the model was trained to detect.

Usage:
    pip install ultralytics opencv-python --break-system-packages
    python test_yolo_webcam.py --model path/to/your_model.pt

Press 'q' to quit the webcam window.
"""

import argparse
import cv2
from ultralytics import YOLO

# ---- Configure your model path here ----
MODEL_PATH = "yolov8n.pt"
# -----------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Test a YOLOv8 .pt model on webcam")
    parser.add_argument(
        "--model", type=str, default=MODEL_PATH,
        help=f"Path to your .pt model file (default: {MODEL_PATH})"
    )
    parser.add_argument(
        "--cam", type=int, default=0,
        help="Webcam index (default 0, try 1/2 if you have multiple cameras)"
    )
    parser.add_argument(
        "--conf", type=float, default=0.4,
        help="Confidence threshold for detections (default 0.4)"
    )
    parser.add_argument(
        "--list-only", action="store_true",
        help="Just print the trained class list and exit (no webcam needed)"
    )
    args = parser.parse_args()

    # Load the model
    print(f"Loading model: {args.model}")
    model = YOLO(args.model)

    # This is the key part — print out ALL classes this model was trained on,
    # straight from the model itself, no .yaml file needed.
    print(f"\n=== This model can detect {len(model.names)} classes ===")
    for idx, name in model.names.items():
        print(f"  {idx}: {name}")
    print("======================================\n")

    # If the user just wants the class list, stop here — no need to open the webcam
    if args.list_only:
        return

    # Open webcam
    cap = cv2.VideoCapture(args.cam)
    if not cap.isOpened():
        print(f"ERROR: Could not open webcam index {args.cam}")
        return

    print("Webcam started. Press 'q' in the window to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Failed to grab frame, exiting.")
            break

        # Run detection on this frame
        results = model.predict(source=frame, conf=args.conf, verbose=False)

        # Draw boxes + labels on the frame
        annotated_frame = results[0].plot()

        # Print detected class names for this frame (only if something found)
        if len(results[0].boxes) > 0:
            detected = [model.names[int(box.cls)] for box in results[0].boxes]
            print("Detected:", detected)

        cv2.imshow("YOLOv8 Webcam Test - press 'q' to quit", annotated_frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()